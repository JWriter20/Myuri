"""Ergonomic constructor tests: from_* wrappers + create_cursor accepting a driver."""
from myuri import (
    CdpDriver,
    Cursor,
    Driver,
    PlaywrightDriver,
    create_cursor,
    from_cdp,
    from_playwright,
)


def test_from_playwright_returns_driver():
    driver = from_playwright(page=object())
    assert isinstance(driver, Driver)
    assert isinstance(driver, PlaywrightDriver)


def test_from_cdp_returns_driver():
    driver = from_cdp(page=object())
    assert isinstance(driver, Driver)
    assert isinstance(driver, CdpDriver)


def test_create_cursor_accepts_driver():
    cursor = create_cursor(from_playwright(object()), seed=9)
    assert isinstance(cursor, Cursor)
    assert cursor.get_seed() == 9
