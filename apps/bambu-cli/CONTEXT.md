# Bambu Printing

Getting a 3D Model onto Connor's Bambu Lab P1S: finding or making a Model,
checking it, reviewing it, slicing it, and starting and watching the print.
The `bambu` CLI does the work, the Review Page shows it, and the `bambu-print`
skill is the agent-facing guide to both.

## Language

### Models

**Model**:
A mesh file (STL, 3MF, OBJ, GLB) that might be printed.
_Avoid_: part (for a mesh file), design, object, asset

**Route**:
How a Model comes to exist: Search, Generate, Make, or Own File.
_Avoid_: mode, path, source

**Search**:
The Route that finds an existing Model on MakerWorld or Printables.

**Generate**:
The Route that has an AI provider turn text or a photo into a Model.
_Avoid_: AI, text-to-3D (as the Route name)

**Make**:
The Route that builds a Model from a script with exact dimensions.
_Avoid_: parametric, CAD, design

**Own File**:
The Route where Connor supplies the Model.

**Candidates**:
The Models a Search returned, with their stats and licence, for Connor to pick from.
_Avoid_: results, hits, options

### Checking and reviewing

**Printability Report**:
The seven checks (mesh, build volume, floating parts, overhangs, wall thickness, bed contact, material) and the 0-10 score for one Model.
_Avoid_: analysis, validation, lint

**Review Page**:
A self-contained HTML page, published to Wovn, that renders one Model or the Candidates for Connor to look at.
_Avoid_: preview, viewer (for the published page), render

**Palette**:
The set of filament colours a painted Model uses, each mapped to a Slot.
_Avoid_: colours, colour scheme

### Printing

**Print Job**:
A named folder holding everything about one print: source, Model, Printability Report, Review Page, and sliced 3MF.
_Avoid_: project, output dir, workspace

**Plate**:
The build surface the print runs on: textured, cool, engineering, or high-temp.
_Avoid_: bed (for the surface type), sheet

**Slot**:
One AMS position (A1-A4) holding a filament.
_Avoid_: tray, spool, channel

## Relationships

- Every **Model** arrives by exactly one **Route**; only **Search** produces **Candidates**
- A **Print Job** holds one **Model** and is named once, at creation; its name follows the file into the VM and onto the printer
- A painted **Model** has one **Palette**; each colour in it names a **Slot**

## Example dialogue

> **Dev:** "The **Printability Report** says bed contact is a point. Do I fix the **Model**?"
> **Connor:** "No, re-run orient first. If it still only touches at a point, add a brim when you slice."

## Flagged ambiguities

- "preview" was used for the published page, the per-plate PNG inside a sliced 3MF, and a camera frame - resolved: **Review Page** is the published page; the plate PNG and the snapshot keep their own names.
