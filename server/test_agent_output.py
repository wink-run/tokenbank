"""产出确认和扣分规则。不连数据库。"""

from agent_output import settle_output, should_award_contributor, should_charge


def test_charge_only_hired_login():
    assert should_charge("hired", False) is True
    assert should_charge("hired", True) is False
    assert should_charge("owner", False) is False


def test_owner_success_does_not_mint_credits():
    assert should_award_contributor("owner", True) is False
    assert should_award_contributor("hired", True) is True
    assert should_award_contributor("hired", False) is False


def test_missing_declared_file_is_not_complete():
    done = settle_output(
        {"status": "completed", "output": "见 a.png"},
        {"files": [], "missing": ["a.png"]},
        [],
        confirmed=True,
    )
    assert done["status"] == "output_missing"


def test_hash_gap_stays_pending():
    done = settle_output(
        {"status": "completed", "output": "ok"},
        {"files": [{"name": "a.png", "sha256": "abc"}], "missing": []},
        [],
        confirmed=True,
    )
    assert done["status"] == "output_pending"


def test_matching_hash_completes():
    done = settle_output(
        {"status": "completed", "output": "ok"},
        {"files": [{"name": "a.png", "sha256": "abc"}], "missing": []},
        [{"name": "a.png", "sha256": "abc"}],
        confirmed=True,
    )
    assert done["status"] == "completed"
    assert done["output_confirmed"] is True


def test_failed_run_is_not_relabelled():
    done = settle_output(
        {"status": "failed", "output": "boom"},
        {"files": [], "missing": ["a.png"]},
        [],
        confirmed=True,
    )
    assert done["status"] == "failed"
    done = settle_output(
        {"status": "completed", "output": "ok", "artifacts_follow": True},
        None,
        [{"name": "a.png"}],
        confirmed=False,
    )
    assert done["status"] == "completed"
    assert done["output_confirmed"] is False
    assert "artifacts_follow" not in done
