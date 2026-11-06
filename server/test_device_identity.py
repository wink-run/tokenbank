"""CLI / Docker 注册时复用已有设备，避免一台容器堆出很多 device id。"""

from device_identity import is_placeholder_device_name, reuse_cli_device_id


def test_docker_new_id_reuses_existing_cli():
    assert reuse_cli_device_id(False, "dev-old", "cli", "172.18.0.3 · CLI :11430") == "dev-old"


def test_known_cli_id_is_kept():
    assert reuse_cli_device_id(True, "dev-old", "cli", "172.18.0.3 · CLI :11430") is None


def test_desktop_is_not_reused_by_name():
    assert reuse_cli_device_id(False, "dev-old", "desktop", "桌面设备") is None


def test_placeholder_cli_name_is_not_reused():
    assert is_placeholder_device_name("CLI 设备 · CLI :11430")
    assert reuse_cli_device_id(False, "dev-old", "cli", "CLI 设备 · CLI :11430") is None
