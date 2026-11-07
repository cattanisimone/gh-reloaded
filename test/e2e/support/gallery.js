// Helpers shared by the image-gallery specs: tiny image bytes served for the
// same-origin ?raw=true URLs, the Contents API listing, and small readers.
import { routeGithub, routeApi, seedStorage } from "./extension.js";

export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const SVG_WITH_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>window.__svgRan = true; document.title = "svg-ran";</script><rect width="40" height="20" fill="#09f"/></svg>`;

export const URL_B = "https://github.com/acme/web/blob/main/shots/b.png";

export const file = (name, dir = "shots") => ({ name, path: `${dir}/${name}`, type: "file" });
export const FOLDER = [file("a.png"), file("b.png"), file("c.svg"), file("README.md"), { name: "x.png", path: "shots/x.png", type: "dir" }];

// Serve image bytes for ?raw=true requests. `broken` lists file names that
// answer 404, `log` collects the requested paths.
export async function routeImages(context, { broken = [], log = [] } = {}) {
  await context.route((u) => u.hostname === "github.com" && u.searchParams.get("raw") === "true", (route) => {
    const u = new URL(route.request().url());
    log.push(decodeURIComponent(u.pathname));
    const name = decodeURIComponent(u.pathname.split("/").pop());
    if (broken.includes(name)) return route.fulfill({ status: 404, body: "" });
    if (/\.svg$/i.test(name)) return route.fulfill({ status: 200, contentType: "image/svg+xml", body: SVG_WITH_SCRIPT });
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 });
  });
}

// Standard setup. `embedded: false` strips the page's embedded folder tree so
// the listing comes from the background API client.
export async function setup(context, { fixture = "blob-image.html", embedded = true, api = [{ match: /\/repos\/acme\/web\/contents\/shots/, json: FOLDER }], storage, broken, images = [], transform } = {}) {
  if (storage) await seedStorage(context, storage);
  await routeApi(context, api);
  await routeGithub(context, fixture, {
    transform: (html) => {
      let out = embedded ? html : html.replace(/<script type="application\/json" data-target="react-app.embeddedData">[\s\S]*?<\/script>/, "");
      if (transform) out = transform(out);
      return out;
    },
  });
  await routeImages(context, { broken, log: images });
}

export const dialog = (page) => page.locator("dialog.ghig-dialog");
export const counter = (page) => page.locator(".ghig-counter");
export const galleryButton = (page) => page.locator(".ghig-btn");
