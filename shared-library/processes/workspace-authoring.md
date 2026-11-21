# Authoring a Workspace project

1. Read the current registry and reuse the relevant project.
2. Reuse the stable project ID at `projects/<id>`. Keep exactly one canonical
   Workspace folder at `projects/<id>/workspace`; do not create dated workspaces
   or another project entry for the same project. An optional owned working
   GitHub checkout belongs directly in `projects/<id>/github`, never nested
   under another repository-name folder. Keep private reports, records and
   assets outside that checkout. Existing active/pinned sources and project
   renderers require a documented, lossless migration; do not move them silently.
3. Write the result in English by default. Use stable tab names and relative
   paths. Keep one main project pinned when it is the user's working hub.
   For directly editable galleries or research, follow
   [the editable card format](../docs/editable-cards.md). Store content in a
   `.card.json` file and register `viewer: "card"`. Preserve stable entry IDs and
   validate before saving. Keep custom HTML when a task needs its own layout.
4. Add the shared report CSS and script; use `data-mak-report="document"`.
   Markdown requires no HTML wrapper and opens in the formatted document view.
5. Make every image clickable and downloadable. Videos need native controls.
   Keep source links near claims and label historical model runs as historical.
6. Update the registry's `updated` date after meaningful changes. Preserve the
   original `created` date. Do not mark personal work `sample: true`.
7. Open every changed tab at wide and narrow widths, test links and media,
   then report the outcome. A built installer is not an installed update.

New HTML reports can begin with:

```html
<!doctype html>
<html lang="en" data-mak-report="document">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project report</title>
  <link rel="stylesheet" href="../_shared/report.css">
  <link rel="stylesheet" href="../_shared/examples.css">
  <script defer src="../_shared/report.js"></script>
</head>
<body><main class="container"><h1>Project report</h1></main></body>
</html>
```

The relative paths above assume a folder immediately inside `workspace/`.
Adjust them for nested reports. All sample pages follow the same shared style.
