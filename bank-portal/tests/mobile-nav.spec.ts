import { expect, test } from "@playwright/test";

test("mobile nav drawer overlays content and closes", async ({ page }) => {
  await page.goto("/");

  const toggle = page.locator("#btn-mobile-nav");
  await expect(toggle).toBeVisible();

  await toggle.click();

  const drawer = page.locator("#fx-nav-drawer");
  await expect(drawer).toHaveClass(/is-open/);

  // The nav should be visible and interactable (not behind the hero).
  const nav = page.locator("#fx-nav-drawer nav.fx-app-nav");
  await expect(nav).toBeVisible();

  const hero = page.locator("section.fx-app-hero");
  await expect(hero).toBeVisible();

  // Sanity: drawer layer is above hero layer.
  const z = await drawer.evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(z)).toBeGreaterThan(1000);

  // Clicking a nav link should close the drawer (wireMobileNav).
  const firstLink = nav.locator("a.fx-app-nav__link").first();
  await firstLink.click();
  await expect(drawer).not.toHaveClass(/is-open/);

  // Re-open and close via backdrop.
  await toggle.click();
  await expect(drawer).toHaveClass(/is-open/);
  await page.locator("#btn-mobile-nav-backdrop").click();
  await expect(drawer).not.toHaveClass(/is-open/);
});

