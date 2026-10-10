import { expect, test } from "@playwright/test";

// Assertions follow what each page.intent.md asks for, not the exact layout, so the same suite
// covers committed specs and freshly generated ones. Tests share one in-memory database and run
// in order: watering comes last because it changes the home page.
// Seed data: Fiddle-leaf fig and Boston fern need water; Monstera, Basil and Aloe do not.

test.describe.configure({ mode: "serial" });

const plant = (page: import("@playwright/test").Page, name: string) => page.getByText(name, { exact: true });

const generation = { timeout: 30_000 }; // replayed pages generate on first visit

test("home lists only the plants that need water and links to them", async ({ page }) => {
  await page.goto("/");
  await expect(plant(page, "Fiddle-leaf fig")).toBeVisible(generation);
  await expect(plant(page, "Boston fern")).toBeVisible();
  await expect(plant(page, "Monstera")).toHaveCount(0);

  await plant(page, "Fiddle-leaf fig").click();
  await expect(page).toHaveURL(/\/plants\/fiddle$/);
});

test("home has a button to all plants", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /plants/i }).first().click(generation);
  await expect(page).toHaveURL(/\/plants$/);
  await expect(plant(page, "Monstera")).toBeVisible(generation);
});

test("plants search filters as you type", async ({ page }) => {
  await page.goto("/plants");
  await expect(plant(page, "Monstera")).toBeVisible(generation);
  await page.getByRole("textbox").first().fill("herb");
  await expect(plant(page, "Basil")).toBeVisible();
  await expect(plant(page, "Monstera")).toHaveCount(0);
});

test("new plant form adds a plant", async ({ page }) => {
  await page.goto("/plants");
  await page.getByRole("button", { name: /new plant/i }).click(generation);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /name/i }).first().fill("Snake plant");
  await dialog.getByRole("textbox", { name: /species/i }).fill("Dracaena trifasciata");
  await dialog.getByRole("textbox", { name: /location/i }).fill("Window");
  await dialog.getByRole("button", { name: /add|create|save|submit/i }).click();
  await expect(plant(page, "Snake plant")).toBeVisible();
});

test("plant page marks a plant as watered", async ({ page }) => {
  await page.goto("/plants/fiddle");
  await expect(page.getByRole("heading", { name: "Fiddle-leaf fig" })).toBeVisible(generation);
  await expect(page.getByText(/needs water/i)).toBeVisible();
  await page.getByRole("button", { name: /mark as watered/i }).click();
  await expect(page.getByText(/needs water/i)).toHaveCount(0);
});

test("no console errors on any page", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of ["/", "/plants", "/plants/basil"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible(generation);
  }
  expect(errors).toEqual([]);
});
