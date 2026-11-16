from pathlib import Path

import myuri

HERE = Path(__file__).resolve().parent.parent


def test_license_files_are_real_copies_of_the_root_ones():
    # Symlinks end up dangling in the sdist, and the wheel built from it then
    # ships without the licence text.
    for name in ("LICENSE", "NOTICE"):
        f = HERE / name
        assert not f.is_symlink(), f"python/{name} must be a file, not a symlink"
        assert f.read_bytes() == (HERE.parent / name).read_bytes(), f"python/{name} differs from ../{name}"


def test_version_is_a_string():
    assert isinstance(myuri.__version__, str)
