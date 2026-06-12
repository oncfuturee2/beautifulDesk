/// <reference types="vite/client" />

declare module "virtual:beautifuldesk-models" {
  const assets: Array<{
    name: string;
    url: string;
    resourcePath: string;
    collider: [number, number, number];
    visualHeight: number;
  }>;

  export default assets;
}
