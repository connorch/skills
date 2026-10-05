// Vite's `?raw` import: the viewer template arrives as a string at build time.
declare module "*.html?raw" {
  const text: string;
  export default text;
}
