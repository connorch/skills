# Prints start through Bambu Connect in the agent VM

The P1S firmware rejects unsigned LAN control commands (HMS `0500-0500-0001-0007`),
and the alternative, Developer Mode, turns off cloud printing and Bambu Handy. So
the `bambu` CLI never starts a print. The skill copies the sliced 3MF into the
`mac-vm` guest, opens it in Bambu Connect there, and drives Connect's print dialog
with computer use; the print goes out through Connor's Bambu cloud account. Status,
camera, and SD-card access stay on the LAN (MQTT, the camera port, FTPS), which the
firmware still allows read-only or for files.

## Considered Options

- **Developer Mode and LAN MQTT `project_file` commands (rejected).** Loses cloud
  printing and Handy for every other use of the printer.
- **Bambu Studio in the VM (rejected).** Crashes under the VM's software OpenGL.
- **Start from the SD card via FTPS upload (kept as a manual fallback).** Needs
  someone at the printer's screen, and once printed in the wrong colour because
  the slot is not chosen in the file.
