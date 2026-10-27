"""兼容 aiosqlite 调用风格的 PostgreSQL 薄封装。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from db_pool import get_pool

_RE_QMARK = re.compile(r"\?")
_RE_AUTOINC = re.compile(r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT", re.I)
_RE_DT_NOW = re.compile(r"datetime\('now'\)", re.I)
_RE_DT_NOW_LIT = re.compile(r"datetime\('now',\s*'([^']+)'\)", re.I)
_RE_INSERT_OR_IGNORE = re.compile(r"INSERT\s+OR\s+IGNORE\s+INTO", re.I)
_RE_PRAGMA_TABLE = re.compile(r"PRAGMA\s+table_info\((\w+)\)", re.I)
_RE_PRAGMA_FK = re.compile(r"PRAGMA\s+foreign_keys\s*=\s*ON", re.I)
_RE_BEGIN_IMMEDIATE = re.compile(r"BEGIN\s+IMMEDIATE", re.I)
_RE_INSERT_INTO = re.compile(r"INSERT\s+INTO\s+(\w+)", re.I)

# 无主键 id 列的表，不可 RETURNING id
_TABLES_WITHOUT_ID = frozenset({
    "system_config",
    "circle_members",
    "circle_announcement_likes",
    "studio_circle_mods",
})


def _qmarks_to_pg(sql: str) -> str:
    idx = 0

    def repl(_: re.Match) -> str:
        nonlocal idx
        idx += 1
        return f"${idx}"

    return _RE_QMARK.sub(repl, sql)


def _dt_offset_repl(m: re.Match) -> str:
    """datetime('now', '-24 hours') → NOW() - INTERVAL '24 hours'"""
    spec = m.group(1).strip()
    if spec.startswith("-"):
        return f"NOW() - INTERVAL '{spec[1:].strip()}'"
    return f"NOW() + INTERVAL '{spec}'"


def _translate_ddl(sql: str) -> str:
    sql = _RE_AUTOINC.sub("SERIAL PRIMARY KEY", sql)
    sql = _RE_DT_NOW_LIT.sub(_dt_offset_repl, sql)
    sql = _RE_DT_NOW.sub("NOW()", sql)
    return sql


def translate_sql(sql: str) -> tuple[str, Optional[str]]:
    stripped = sql.strip()

    m = _RE_PRAGMA_TABLE.match(stripped)
    if m:
        return m.group(1), "pragma_table_info"

    if _RE_PRAGMA_FK.match(stripped):
        return "", "noop"

    if _RE_BEGIN_IMMEDIATE.match(stripped):
        return "", "begin_tx"

    if stripped.upper() == "ROLLBACK":
        return "", "rollback"

    if stripped.upper() == "COMMIT":
        return "", "commit"

    out = sql
    if _RE_INSERT_OR_IGNORE.search(out):
        out = _RE_INSERT_OR_IGNORE.sub("INSERT INTO", out)
        if "system_config" in out and "ON CONFLICT" not in out.upper():
            out = out.rstrip().rstrip(";") + " ON CONFLICT (key) DO NOTHING"
        elif "circle_members" in out and "ON CONFLICT" not in out.upper():
            out = out.rstrip().rstrip(";") + " ON CONFLICT (circle_id, user_id) DO NOTHING"

    upper = out.strip().upper()
    if upper.startswith(("CREATE", "ALTER")):
        out = _translate_ddl(out)
    else:
        out = _RE_DT_NOW_LIT.sub(_dt_offset_repl, out)
        out = _RE_DT_NOW.sub("NOW()", out)

    return _qmarks_to_pg(out), None


class PgRow(Mapping):
    """兼容 aiosqlite.Row：同时支持 row[0] 与 row['col']，且可 dict(row)。"""

    __slots__ = ("_values", "_map")

    def __init__(self, keys: list[str], values: list[Any]):
        self._values = list(values)
        self._map = dict(zip(keys, values))

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._map[key]

    def __iter__(self):
        return iter(self._map)

    def __len__(self) -> int:
        return len(self._map)

    def get(self, key, default=None):
        if isinstance(key, int):
            try:
                return self._values[key]
            except IndexError:
                return default
        return self._map.get(key, default)


def _pg_row(record) -> PgRow:
    keys = list(record.keys())
    return PgRow(keys, [record[k] for k in keys])


class PgCursor:
    def __init__(self, rows: list[Any], lastrowid: Optional[int] = None, rowcount: int = 0):
        self._rows = rows
        self._idx = 0
        self.lastrowid = lastrowid
        self.rowcount = rowcount

    async def fetchone(self) -> Any:
        if self._idx < len(self._rows):
            row = self._rows[self._idx]
            self._idx += 1
            return row
        return None

    async def fetchall(self) -> list[Any]:
        rest = self._rows[self._idx :]
        self._idx = len(self._rows)
        return rest

    def __aiter__(self) -> AsyncIterator[Any]:
        return self

    async def __anext__(self) -> Any:
        if self._idx >= len(self._rows):
            raise StopAsyncIteration
        row = self._rows[self._idx]
        self._idx += 1
        return row

    async def __aenter__(self) -> "PgCursor":
        return self

    async def __aexit__(self, *_) -> None:
        pass


class _ExecuteContext:
    """兼容 aiosqlite：支持 async with db.execute(...) 与 cur = await db.execute(...)。"""

    def __init__(self, conn: "PgConnection", sql: str, params: tuple):
        self._conn = conn
        self._sql = sql
        self._params = params
        self._cursor: PgCursor | None = None

    def __await__(self):
        return self._ensure_cursor().__await__()

    async def _ensure_cursor(self) -> PgCursor:
        if self._cursor is None:
            self._cursor = await self._conn._run_execute(self._sql, self._params)
        return self._cursor

    async def __aenter__(self) -> PgCursor:
        return await self._ensure_cursor()

    async def __aexit__(self, *_) -> None:
        pass


class PgConnection:
    row_factory = None

    def __init__(self, conn):
        self._conn = conn
        self._tx = None

    def execute(self, sql: str, params: tuple | list = ()) -> _ExecuteContext:
        return _ExecuteContext(self, sql, tuple(params))

    async def _run_execute(self, sql: str, params: tuple) -> PgCursor:
        pg_sql, special = translate_sql(sql)
        args = tuple(params)

        if special == "noop":
            return PgCursor([], rowcount=0)

        if special == "begin_tx":
            self._tx = self._conn.transaction()
            await self._tx.start()
            return PgCursor([], rowcount=0)

        if special == "rollback":
            if self._tx:
                await self._tx.rollback()
                self._tx = None
            return PgCursor([], rowcount=0)

        if special == "commit":
            if self._tx:
                await self._tx.commit()
                self._tx = None
            return PgCursor([], rowcount=0)

        if special == "pragma_table_info":
            table = pg_sql
            rows = await self._conn.fetch(
                """
                SELECT ordinal_position - 1 AS cid, column_name AS name,
                       data_type AS type, is_nullable, column_default, ''
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                ORDER BY ordinal_position
                """,
                table,
            )
            return PgCursor([_pg_row(r) for r in rows])

        upper = pg_sql.strip().upper()
        is_insert = upper.startswith("INSERT") and "RETURNING" not in upper

        if is_insert:
            m = _RE_INSERT_INTO.search(pg_sql)
            table = m.group(1) if m else ""
            if table not in _TABLES_WITHOUT_ID:
                pg_sql = pg_sql.rstrip().rstrip(";") + " RETURNING id"

        if upper.startswith("SELECT") or is_insert:
            records = await self._conn.fetch(pg_sql, *args)
            rows = [_pg_row(r) for r in records]
            lastrowid = rows[0].get("id") if is_insert and rows else None
            return PgCursor(rows, lastrowid=lastrowid, rowcount=len(rows))

        status = await self._conn.execute(pg_sql, *args)
        rowcount = 0
        if status:
            parts = status.split()
            if len(parts) == 2 and parts[1].isdigit():
                rowcount = int(parts[1])
        return PgCursor([], rowcount=rowcount)

    async def fetch_one(self, sql: str, params: tuple | list = ()):
        """兼容 tools_router / seeds：单行查询。"""
        cur = await self.execute(sql, tuple(params or ()))
        return await cur.fetchone()

    async def fetch_all(self, sql: str, params: tuple | list = ()):
        """兼容 tools_router / seeds：多行查询。"""
        cur = await self.execute(sql, tuple(params or ()))
        return await cur.fetchall()

    async def commit(self) -> None:
        if self._tx:
            await self._tx.commit()
            self._tx = None

    async def __aenter__(self) -> "PgConnection":
        return self

    async def __aexit__(self, *_) -> None:
        if self._tx:
            await self._tx.rollback()
            self._tx = None


@asynccontextmanager
async def connect() -> AsyncIterator[PgConnection]:
    pool = get_pool()
    async with pool.acquire() as conn:
        yield PgConnection(conn)
