// Where Bambu Studio lives on a Mac. Slicing runs its CLI; the profiles are
// the machine, process and filament presets the slicer needs flattened.
export const STUDIO = "/Applications/BambuStudio.app";
export const STUDIO_CLI = `${STUDIO}/Contents/MacOS/BambuStudio`;
export const PROFILES = `${STUDIO}/Contents/Resources/profiles/BBL`;
