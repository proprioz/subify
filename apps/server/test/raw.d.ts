// Fixtures are imported as text through Vite's `?raw` suffix, which works on Node and in workerd alike.
declare module '*?raw' {
  const content: string;
  export default content;
}
