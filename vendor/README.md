# Browser dependencies

These pinned browser distributions are included directly in the generated HTML,
so opening `index.html` does not require a network connection or a local server.
Their license texts are also embedded in that HTML by `build.mjs`.

| Package | Version | Browser distribution | Official documentation |
| --- | --- | --- | --- |
| marked | 18.1.1 | `marked.umd.js` | https://marked.js.org/ |
| DOMPurify | 3.4.17 | `purify.min.js` | https://github.com/cure53/DOMPurify |
| lucide | 1.55.0 | `lucide.min.js` | https://lucide.dev/guide/lucide |

Versions were checked against each package's official npm `latest` metadata on
2026-10-13. Distributions and licenses come from those pinned npm packages via
jsDelivr, which serves the packages published by the library maintainers.

Download URLs:

- https://cdn.jsdelivr.net/npm/marked@18.1.1/lib/marked.umd.js
- https://cdn.jsdelivr.net/npm/marked@18.1.1/LICENSE
- https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js
- https://cdn.jsdelivr.net/npm/dompurify@3.4.17/LICENSE
- https://cdn.jsdelivr.net/npm/lucide@1.55.0/dist/umd/lucide.min.js
- https://cdn.jsdelivr.net/npm/lucide@1.55.0/LICENSE
