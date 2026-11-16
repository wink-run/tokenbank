"""一台节点：一部分模型给圈子，一部分对所有人公开。"""
from worker_pool import WorkerConnection, WorkerPool


def _pool():
    pool = WorkerPool()
    w = WorkerConnection(ws=None, models=["pub-m", "circle-m"], worker_id="w1", name="n1",
                         user_id=1, circle_ids=[7], public_models=["pub-m"])
    pool.add(w)
    return pool


def test_public_model_visible_to_everyone():
    pool = _pool()
    assert set(pool.models_for_user(None, set())) == {"pub-m"}
    assert [w.worker_id for w in pool.candidates("pub-m", user_circle_ids=set())] == ["w1"]
    assert pool.candidates("circle-m", user_circle_ids=set()) == []


def test_circle_member_sees_both():
    pool = _pool()
    assert set(pool.models_for_user(None, {7})) == {"pub-m", "circle-m"}
    assert pool.circle_model_ids_for_user(None, {7}) == {"circle-m": 7}
    assert [m["id"] for m in pool.models_for_circle(7)] == ["circle-m"]


def test_old_client_without_public_models_stays_circle_only():
    pool = WorkerPool()
    pool.add(WorkerConnection(ws=None, models=["a"], worker_id="w2", name="n2", user_id=2, circle_ids=[7]))
    assert pool.models_for_user(None, set()) == {}
    assert set(pool.models_for_user(None, {7})) == {"a"}


def test_worker_without_circle_is_all_public():
    pool = WorkerPool()
    pool.add(WorkerConnection(ws=None, models=["a", "b"], worker_id="w3", name="n3", user_id=3))
    assert set(pool.models_for_user(None, set())) == {"a", "b"}


def test_each_model_its_own_circles():
    pool = WorkerPool()
    pool.add(WorkerConnection(ws=None, models=["pub", "front", "family"], worker_id="w4", name="n4", user_id=4,
                              circle_ids=[7, 8], model_circles={"front": [7], "family": [8]}))
    assert set(pool.models_for_user(None, set())) == {"pub"}
    assert set(pool.models_for_user(None, {7})) == {"pub", "front"}
    assert set(pool.models_for_user(None, {8})) == {"pub", "family"}
    assert [m["id"] for m in pool.models_for_circle(8)] == ["family"]
    assert pool.candidates("family", user_circle_ids={7}) == []


def test_each_agent_card_its_own_circles():
    from worker_pool import normalize_agent_cards
    cards = normalize_agent_cards([
        {"id": "a1", "name": "a1", "circle_ids": [7]},
        {"id": "a2", "name": "a2", "circle_ids": []},
        {"id": "a3", "name": "a3", "circle_ids": [8]},
    ])
    assert [c["visibility"] for c in cards] == ["circle", "public", "circle"]
    pool = WorkerPool()
    pool.add(WorkerConnection(ws=None, models=[], worker_id="w5", name="n5", user_id=5, circle_ids=[7, 8], agents=cards))
    assert {r["id"] for r in pool.list_agents_for_user(set())} == {"a2"}
    seen7 = {r["id"]: r["circle_ids"] for r in pool.list_agents_for_user({7})}
    assert seen7 == {"a1": [7], "a2": []}
