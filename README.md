# VALID-AI Assessment Designer

A static web app for designing AI-aware assessments with the VALID-AI framework (Verify, Articulate, Locate, Inspect, Design, Assign, Implement) and the AI Assessment Scale (AIAS 2.1). It can also personalize the plan with a **local** AI model, so course details never leave the instructor's computer.

This version uses the updated visual design and keeps the local AI and the bug fixes from the previous build.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `styles.css` | The visual design: light and dark themes, print, phone layout |
| `data.js` | All static content: guidance, starting approaches, patterns, research examples |
| `app.js` | Wizard, plan logic, rubric, saving, and the local AI panel |
| `llm.js` | Device checks and the two AI engines (in-browser WebLLM and Ollama) |
| `tasks.js` | Prompts, JSON schemas, and checks for the three AI tasks |
| `webllm.js` | Pins the WebLLM version (0.2.86) in one place |
| `worker.js` | Runs the in-browser model off the main thread |

There's no build step and nothing to install.

## Deploy to GitHub Pages

1. Upload all nine files (these eight plus this README) to the root of the repository, replacing the old ones. `webllm.js` is new.
2. In **Settings → Pages**, the source should be **Deploy from a branch**, branch `main`, folder `/ (root)`. If the site is already published, nothing changes here.
3. Give it a minute, then hard-refresh the site (Shift+Reload) so the browser picks up the new files.

The pages are ES modules, which don't run from `file://`. To try the site on your own computer, run `python3 -m http.server` in the folder and open `http://localhost:8000`.

Answers saved by the previous version still load.

## Editing on the plan page

Each step in the plan summary has an **Edit** button. It opens that step's questions in place; **Update plan** refreshes every section, and **Cancel** (or Escape) puts the answers back. **Edit answers** still opens the full step-by-step wizard.

If you change wording after running the local AI, its sections stay and are labeled "Made before your latest edits." If a change alters the rubric's criteria (for example the evidence type or the role of AI), the AI sections are cleared, because the rewritten descriptors would no longer line up.

## Export the rubric to Canvas

The **Draft rubric** section has **Download Canvas CSV**. Set a rubric name and total points first (default 100). Points follow the criterion weights and split 4-3-2-1 across Exemplary, Proficient, Developing and Beginning. The file uses whatever descriptors are on screen, AI-personalized or template.

The format follows Canvas's own rubric importer (`lib/rubric_csv_importer.rb` in canvas-lms): one row per criterion, grouped by `Rubric Name`, with repeating `Rating Name` / `Rating Description` / `Rating Points` columns. The file has no byte-order mark, because one would break the `Rubric Name` header.

To import it: in the course, open **Rubrics** and select **Import Rubric**, then upload the file. Imported rubrics arrive as drafts, so open the rubric and select **Save Rubric**. The file can't set the rating order or scoring options; set those in Canvas. Then attach the rubric to the assignment with **Find Rubric**. Holistic, checklist and specifications layouts are exported as the analytic grid, since that's what Canvas rubrics are.

This is the rubric import. The Canvas article on importing rubric *assessments* covers uploading students' scores, which is a different file.

## How the local AI works

After you build a plan, the **Personalize with local AI** card offers two ways to run a model:

1. **In this browser (WebLLM).** This needs WebGPU, which current Chrome and Edge have on most recent computers. The card recommends a model for the device. The first run downloads it once; after that it loads from the browser's storage.
2. **Ollama on this computer.** Click **Have Ollama installed? Connect to it**. The page never contacts Ollama until someone clicks this, because Chrome may ask permission to reach devices on the local network. After one successful connection, it reconnects automatically on later visits.

If neither is available, the card says why, and everything else works as before.

The model does three jobs, in this order. Each section appears as soon as it's ready:

- **Alignment check.** It flags up to five contradictions between answers and names the questions involved.
- **Student AI-use instructions.** It drafts what is permitted, what is prohibited, and what students must submit. A **Copy text** button copies the draft.
- **Rubric descriptors.** It rewrites the four levels of each criterion around the instructor's own answers. Criterion names and weights stay fixed. **Show template version** switches back and forth.

Every reply is forced into a JSON schema, so it always fits the page. The model is never asked for research, citations, the AIAS level, or the approach ranking; those stay deterministic. If answers change after a run, the AI sections are cleared when the plan is rebuilt, and the card says so. **Stop** cancels a run and keeps any sections that already finished.

What leaves the computer: in-browser mode downloads the WebLLM library from `cdn.jsdelivr.net` and the model files from `huggingface.co`. Course details are never sent anywhere.

### In-browser models

| Model | GPU memory needed | Notes |
|---|---|---|
| Qwen3 4B | about 3.4 GB | Best quality; recommended on capable laptops |
| Qwen2.5 3B | about 2.5 GB | Balanced |
| Qwen3 1.7B | about 2.0 GB | Lighter |
| Llama 3.2 1B | about 0.9 GB | Smallest; lowest quality |

These figures are for GPUs that support 16-bit math. Others get the 32-bit versions, which need a little more memory. To change the list, edit `BROWSER_MODELS` in `llm.js`. To upgrade WebLLM, change the version in `webllm.js` and check that the model IDs still exist.

### Optional: connect Ollama for better quality

1. Install Ollama from https://ollama.com and pull a model, for example `ollama pull qwen3:8b` or `ollama pull gemma3:12b`.
2. Let the site reach it by setting `OLLAMA_ORIGINS` to the site's address:
   - **macOS:** run `launchctl setenv OLLAMA_ORIGINS "https://<your-username>.github.io"`, then quit and reopen Ollama.
   - **Windows:** add a user environment variable named `OLLAMA_ORIGINS` with that value, then restart Ollama.
   - **Linux (systemd):** add `Environment="OLLAMA_ORIGINS=https://<your-username>.github.io"` to the service override, then restart Ollama.
3. Reload the page, build a plan, and click **Have Ollama installed? Connect to it**. If Chrome asks to allow access to devices on your local network, allow it.

This works in Chrome, Edge, and Firefox. Safari may block a secure site from reaching `localhost`.

## What was tested

The site was run in headless Chromium with 113 automated checks:

- the full wizard
- the plan staying on screen
- typing without losing focus
- saving and restoring
- Start over
- the recommendation flow
- the colors
- an accessibility scan (axe-core, light and dark, with no violations)
- phone width
- print
- editing on the plan page
- the Canvas export, also parsed with Canvas's own importer code to confirm it reads the file

The local AI was tested three ways:

- **Ollama path:** against a stand-in Ollama server, end to end, including Stop and the fallback for models that reject the "think" option.
- **Browser path:** against a stand-in browser model, to check the download progress, the per-model settings, and switching models.
- **Real library:** with the real WebLLM 0.2.86 library on emulated WebGPU. It loaded, started the worker, and requested the correct model files. The download was blocked in the test environment, and the page reported that clearly.

**Not yet tested:** real model output. The first live run on a real computer is still to come. If anything goes wrong, copy the message from the card or the browser console.

## Changes from the updated design file

The design file reintroduced several bugs from the original tool and added a few new ones. All of these are fixed here:

- The plan no longer vanishes a moment after **Build my assessment plan**, or after changing the research example.
- Typing in a text box no longer loses focus.
- The accent colors in the new design now show. Duplicate style rules had been overriding them: the starter guidance labels, the "Not sure?" links, the section +/– icons, the rubric header row, the approach and example labels, and the recommendation note.
- **Start over** now asks first and then clears everything. **Or start with blank answers** really starts blank.
- The rubric has five distinct criteria (35/25/15/15/10), not three overlapping reasoning criteria worth 80%.
- AI critique maps to AIAS 3, and the alignment notes catch more mismatches.
- Starting approaches never overwrite answers you've edited. Inserting an example asks before replacing your text.
- The plan view is restored on reload.
- External links open in a new tab, so the tool isn't lost.

Additions:

- The local AI card, the AI sections, and the AI-personalized rubric toggle.
- A dark theme that follows the computer's setting, matched to the new palette.
- Print or save as PDF, which opens every section.
- Accessibility work: a main landmark, focus moves to each new step, screen-reader announcements for AI progress, larger touch targets on phones, and Windows High Contrast support.
- Teal, amber, and green are a shade darker than in the design file, so small text in those colors meets WCAG AA contrast.
- The unused tooltip and icon libraries and the sandboxed wrapper are gone.

## Known limitations

- **Small models make mistakes.** Treat every AI section as a draft, especially the alignment check.
- **The research examples are unverified.** The 10 examples and their links are unchanged from the original tool. Check each citation before sharing the tool widely.
- **Canvas.** Embedding the page in a Canvas iframe may block WebGPU or model caching. Link to it instead.
- **Saved per browser.** Answers are saved in the browser's local storage and are not shared between devices.
