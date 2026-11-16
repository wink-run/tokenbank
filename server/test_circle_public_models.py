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
