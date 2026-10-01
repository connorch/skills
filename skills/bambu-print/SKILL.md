---
name: bambu-print
description: Use when the user asks to 3D print something, slice a model, check on the Bambu printer, or see what is on the print bed. Covers status, camera, slicing, and starting prints through Bambu Connect.
metadata:
  machines: [connors-mac-studio]
  requires: "the bambu CLI on PATH, Bambu Studio in /Applications for slicing, and the mac-vm skill with Bambu Connect in the guest for starting prints"
---

# Bambu print

Connor's Bambu Lab P1S sits on the home LAN. The `bambu` CLI reads its state
and camera and slices models; it cannot start prints. The printer's firmware
rejects unsigned LAN control commands (HMS `0500-0500-0001-0007`) and Developer
Mode would turn off cloud printing and Bambu Handy, so **prints start from Bambu
Connect**, driven through computer use.

```sh
bambu status                # state, temps, AMS trays (A1-A4), alerts
bambu status --json         # raw report; AMS trays under ams.ams[].tray[]
bambu snapshot [out.jpg]    # one camera frame
bambu slice model.stl --out dir [--plate textured|cool|engineering|high-temp] [--filament "<profile>"]
bambu files                 # SD card root
bambu upload <file>         # copy to the SD card root, for starting from the printer's own screen
```

Printer config is `~/.config/bambu/printer.json` (`host`, `serial`,
`keychainService`); the LAN access code is in the Keychain under that service,
account `bblp`. If auth fails, the code was regenerated on the printer: ask
Connor for the new one.

## Rules

- **Confirm with Connor before starting a print**, stating the file, plate,
  bed temperature, AMS slot, time, and grams. Anything physical waits for a yes.
- **Check the plate before every print.** Take a fresh `snapshot` and look at
  it. A finished job (`FINISH`) usually means the last print is still on the
  plate. If anything is on it, or the image is unclear, do not print: send
  Connor the snapshot and wait. A snapshot is only good for the moment it was
  taken; after Connor says he cleared it, take a new one.
- **Never start a print while the printer is busy** (`RUNNING`, `PAUSE`,
  `PREPARE`).
- **Pick the AMS slot in Connect's print dialog.** Never edit a sliced 3mf to
  steer slot mapping; starting from the SD card maps by its own rules and has
  printed in the wrong color.

## Slicing

`bambu slice` flattens Bambu Studio's system profiles (Studio's CLI skips their
`inherits` chain, which silently produced a 35C bed and a failed print) and
refuses output with 0 g of filament or a bed temperature that does not match
the filament and plate. Defaults: P1S 0.4 nozzle, 0.20mm Standard, Bambu PLA
Basic, textured PEI plate. Check its per-plate summary lines before offering to print, and
show Connor each plate's preview (`Metadata/plate_<n>.png` inside the 3mf).

For a simple custom part (a plate, bracket, or extruded outline), generate an
STL from code rather than asking for CAD: extrude a 2D polygon into a binary
STL, then slice it.

## Starting a print

Prints go through **Bambu Connect** in the `mac-vm` guest, which works whether
or not the Mac is locked. Connect sends an already-sliced file over Connor's
Bambu cloud account. Bambu Studio itself crashes in the guest (software
OpenGL), and Connect's LAN Discover cannot see the printer through Tart's NAT,
so rely on the cloud login. Connor is already signed in to Connect in the guest.

1. Confirm with Connor and check the plate (see Rules).
2. Note whether `mac-vm status` shows the VM already running. Then
   `mac-vm up --forward 18789` and copy the sliced 3mf in with a
   `.gcode.3mf` name, which is what Connect imports:
   `tart exec -i agent-vm sh -c 'cat > ~/Downloads/job.gcode.3mf' < job.3mf`.
3. `tart exec agent-vm open "/Applications/Bambu Connect.app"` (by path;
   `open -a` does not find it). With the computer tool on the **Agent VM** node:
   Import file, click Downloads in the sidebar, double-click the file (typing a
   path into Go to Folder does not work), then Print.
4. In Send to print: check the printer is Connor's Garage P1S and the plate
   matches, click the filament box and pick the slot Connor chose (it defaults
   to another slot), Timelapse off, Bed leveling on, then Send.
5. Confirm it started: `bambu status` shows `PREPARE` or `RUNNING`, and a
   snapshot a few minutes later shows a first layer stuck to the plate.
6. `mac-vm down`, unless the VM was already running before step 2. The job
   runs on the printer, so the VM is not needed once it starts.

Watch the first layer. If the snapshot shows strands or a part lifting off the
plate, tell Connor right away; stopping has to happen from Connect, Handy, or
the printer itself, and only with his yes.

To delete files from the SD card (the CLI has no command for it), use FTPS
with the access code: `curl -s --ssl-reqd -k --user "bblp:$CODE"
ftps://<host>:990/ -Q "DELE /<file>"`. Ask Connor first.
