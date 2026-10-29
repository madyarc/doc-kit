"""Headless Firefox (Selenium) for checking and exporting talks. Needs: pip install "doc-kit[tools]" and Firefox."""
import time

NO_ANIM = "*,*::before,*::after{transition:none!important;animation:none!important}"


def firefox(width=1280, height=720):
    from selenium import webdriver
    opts = webdriver.FirefoxOptions()
    opts.add_argument("-headless")
    driver = webdriver.Firefox(options=opts)
    driver.set_window_size(width, height)
    iw, ih = driver.execute_script("return [innerWidth, innerHeight]")
    driver.set_window_size(width + (width - iw), height + (height - ih))
    return driver


def open_deck(driver, url, timeout=90):
    """Load a deck URL and wait until doc-kit reports ready; returns its report."""
    driver.get(url)
    end = time.time() + timeout
    while time.time() < end:
        if driver.execute_script("return !!(window.docKit && window.docKit.isReady)"):
            driver.execute_script(
                "const s=document.createElement('style');s.textContent=arguments[0];document.head.appendChild(s)", NO_ANIM)
            return driver.execute_script("return {errors: docKit.report.errors, tbds: docKit.report.tbds}")
        time.sleep(0.1)
    raise TimeoutError(f"deck did not become ready: {url}")


def wait_for(driver, flag, timeout=30):
    end = time.time() + timeout
    while not driver.execute_script(f"return !!window.{flag}"):
        if time.time() > end:
            raise TimeoutError(f"page flag {flag} not set")
        time.sleep(0.1)
