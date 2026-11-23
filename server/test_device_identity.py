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


def test_linux_kernel_upgrade_is_same_device():
    """宿主机升级内核后平台说明里的版本号变了，仍是同一台"""
    from device_identity import device_identity_key
    a = device_identity_key("tokenbank-gateway · CLI :11430", "Linux 6.8.0-45-generic · x64")
    b = device_identity_key("tokenbank-gateway · CLI :11430", "Linux 6.8.0-51-generic · x64")
    assert a == b
    assert device_identity_key("box", "Linux 6.8.0 · arm64") != device_identity_key("box", "Linux 6.8.0 · x64")
    assert device_identity_key("mac", "macOS 15.5 · Apple Silicon")[1] == "macos 15.5 · apple silicon"
