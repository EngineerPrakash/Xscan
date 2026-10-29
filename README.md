# Xscan – 3D dental scan viewer

View your dental CBCT / X-ray scan in 3D, right in the browser. **No install, no upload** – files are read locally by your browser and never leave your device.

## Use it

Open `index.html` in a recent Chrome, Edge, Firefox or Safari (it needs WebGL2). Double-clicking the file works; you can also serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Then drop your scan **folder** onto the page (or use *Open folder…* / *Open files…*). Click *Try demo* to see it with a synthetic jaw.

### What it opens
| Format | Notes |
|---|---|
| **DICOM** | Folder of slices (extension-less files and `DICOMDIR` are fine), loose `.dcm`, multi-frame files, or a `.zip` of them. Uncompressed, deflated, baseline-JPEG or **JPEG-Lossless** (the usual dental CBCT export) transfer syntaxes. Slices are sorted by position; if the export has several series you can pick one. |
| **NIfTI** | `.nii`, `.nii.gz` (orientation assumed RAS) |
| **PNG / JPG** | Panoramic / bitewing exports, shown as a flat image |

Not supported yet: DICOM compressed with JPEG 2000, JPEG-LS or RLE. If you hit that, ask the clinic for an *uncompressed* export or convert with 3D Slicer / Horos / `dcmdjpeg`.

### Features
- **3D**: *Surface* (shaded bone/teeth with adjustable threshold – peel from skin to bone to teeth/implants), *X-ray* (simulated radiograph you can rotate), *MIP*; crop/cut-away, preset views, PNG snapshot.
- **Slices**: linked axial / coronal / sagittal views with crosshair, window/level presets, zoom/pan, thick-slab averaging or MIP, and a millimetre **ruler**.

## Project layout
```
index.html          page
css/style.css
js/jpegll.js        JPEG-Lossless decoder
js/loaders.js       DICOM / NIfTI / zip / image parsing
js/volume.js        stats, GPU-sized resampling, demo phantom
js/renderer.js      WebGL2 ray-caster + orbit camera
js/slices.js        2D MPR views
js/app.js           UI wiring
vendor/             dicom-parser (MIT), fflate (MIT)
tools/make-test-dicom.js   writes the demo phantom as a DICOM folder for testing
```
No build step; plain scripts so it also works from `file://`.

> Xscan is for personal viewing only. It is **not a medical device** and must not be used for diagnosis or treatment planning.
