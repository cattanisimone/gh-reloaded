// features/image-gallery/model.js — the pure logic of the Image gallery:
// route and extension rules, the folder set, the listing-state precedence,
// counter and announcement wording, and href encoding. No DOM, no chrome.*,
// so content.js and the unit tests share it. Exposed as globalThis.GHIG_MODEL.

(function () {
  const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  const LIMIT = 1000; // the Contents API caps a directory listing here

  function extOf(name) {
    const m = /\.([^./]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function isSupportedImage(name) {
    return IMAGE_EXT.includes(extOf(name));
  }

  // /owner/repo/blob/<ref and path, unsplit> → null for every other route
  // (blame, raw, tree, PR diffs...). The ref/path boundary is ambiguous from
  // the URL alone when the ref contains a slash, so the caller resolves it.
  function parseBlobPath(pathname) {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(pathname || "");
    if (!m) return null;
    let segments;
    try {
      segments = m[3].split("/").map(decodeURIComponent);
    } catch {
      return null;
    }
    if (segments.length < 2 || segments.some((s) => s === "")) return null;
    return { owner: m[1], repo: m[2], segments, name: segments[segments.length - 1] };
  }

  // Splits `segments` into ref and path. `refName` (the page's embedded ref,
  // or a known one) wins; otherwise the first split, which the background
  // widens by probing.
  function splitRef(segments, refName) {
    if (refName) {
      const refSegs = refName.split("/");
      if (segments.length > refSegs.length && refSegs.every((s, i) => s === segments[i])) {
        return { ref: refName, path: segments.slice(refSegs.length).join("/") };
      }
      return null;
    }
    return { ref: segments[0], path: segments.slice(1).join("/") };
  }

  function dirOf(path) {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  // The URL of a file on GitHub. The ref is kept raw (slashes stay slashes),
  // each path segment is encoded.
  function fileHref(owner, repo, ref, path) {
    return `/${owner}/${repo}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${encodePath(path)}`;
  }

  // Files only, supported images only, in the order of the source.
  function imageSet(entries) {
    return (entries || [])
      .filter((e) => e && (e.type === "file" || e.contentType === "file") && isSupportedImage(e.name))
      .map((e) => ({ name: e.name, path: e.path }));
  }

  // The listing is provably complete only below the cap and when the source's
  // own total agrees with what it handed over.
  function isComplete(received, total) {
    if (received >= LIMIT) return false;
    return total == null || total === received;
  }

  // Notice precedence, first match wins (a) → (c) → rate → error → (d).
  function listingState({ blobMissing, privateNoToken, rateLimited, networkError, ambiguous }) {
    if (blobMissing) return "none";
    if (privateNoToken) return "private";
    if (rateLimited) return "rate-limit";
    if (networkError) return "error";
    if (ambiguous) return "unknown";
    return "ok";
  }

  const NOTICES = {
    incomplete: {
      full: "Incomplete list: GitHub returned only part of this very large folder. Some images may not appear.",
      short: "Incomplete list: some images in this folder may be missing.",
      description: "Incomplete list: GitHub returned only part of this very large folder. Some images may not appear.",
    },
    "rate-limit": {
      full: "Gallery unavailable: GitHub request limit reached. Try again later.",
      short: "Gallery unavailable: GitHub request limit",
      description:
        "Gallery unavailable for this folder: GitHub has temporarily limited requests (rate limit), so the file list could not be read. The file preview works normally; try again later by reloading the page.",
    },
    private: {
      full: "Gallery unavailable: no GH Reloaded token applies to this private repository.",
      short: "Gallery: no token for this repository",
      description:
        "Gallery unavailable: this repository is private and no GH Reloaded token applies to it, so the folder list cannot be read. The file preview works normally. Set the token in the GH Reloaded settings (the one already documented for HTML preview, Contents: Read-only).",
    },
    error: {
      full: "Gallery unavailable: could not read the folder list. Try again later.",
      short: "Gallery unavailable: list not readable",
      description:
        "Gallery unavailable: GitHub did not return the list for this folder (network or server error). The file preview works normally; try again later.",
    },
    unknown: {
      full: "Gallery unavailable: GitHub did not return this folder's list. GH Reloaded can't tell why.",
      short: "Gallery unavailable: can't tell why",
      description:
        "Gallery unavailable: GitHub did not return the list for this folder, and GH Reloaded can't tell whether this is about access, the token or the file. The file preview works normally. You can check a token with Verify access in the GH Reloaded settings.",
    },
    "not-in-list": {
      full: "Gallery unavailable: this file isn't in the folder list GitHub returned.",
      short: "Gallery unavailable: file not in the list",
      description:
        "Gallery unavailable: this file isn't in the folder list GitHub returned, so the gallery can't start from it. The file preview works normally.",
    },
  };

  function noticeFor(kind) {
    return NOTICES[kind] || null;
  }

  function counterText(n, m, incomplete) {
    return incomplete ? `${n} of ${m}+` : `${n} of ${m}`;
  }

  function counterTooltip(n, m, incomplete) {
    return incomplete ? `Image ${n} of at least ${m}: the folder list is incomplete` : "";
  }

  function announcement(n, m, incomplete) {
    return incomplete ? `image ${n} of at least ${m}, folder list incomplete` : `image ${n} of ${m}`;
  }

  function hintText(count) {
    return count > 1 ? "←→ to navigate · Esc to close" : "Esc to close";
  }

  // Circular step through a set of `count` images.
  function step(index, delta, count) {
    return (((index + delta) % count) + count) % count;
  }

  // Keeps the start and the end of a long name, where the differing part
  // usually is, and cuts the middle.
  function middleCut(name, max) {
    if (name.length <= max) return name;
    const keep = max - 1;
    const tail = Math.ceil(keep * 0.55);
    const head = keep - tail;
    return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
  }

  const FAILURE = {
    neutral: {
      title: "Can't show this image",
      text: (name) => `${name} couldn't be shown. You can try opening it with "Open file on GitHub".`,
    },
    damaged: {
      title: "Can't display this image",
      text: (name) => `${name} may be damaged or in an unreadable format. You can open it with "Open file on GitHub".`,
    },
    removed: {
      title: "File no longer available",
      text: (name, ref) => `${name} is no longer on ${ref}: it may have been moved or deleted after the page opened.`,
    },
    refused: {
      title: "Can't load this image",
      text: (name) => `GitHub refused access to ${name} for GH Reloaded. You can try opening it with "Open file on GitHub".`,
    },
  };

  function failureMessage(kind, name, ref) {
    const f = FAILURE[kind] || FAILURE.neutral;
    return { title: f.title, text: f.text(name, ref) };
  }

  globalThis.GHIG_MODEL = {
    IMAGE_EXT,
    LIMIT,
    isSupportedImage,
    parseBlobPath,
    splitRef,
    dirOf,
    encodePath,
    fileHref,
    imageSet,
    isComplete,
    listingState,
    noticeFor,
    counterText,
    counterTooltip,
    announcement,
    hintText,
    step,
    middleCut,
    failureMessage,
  };
})();
