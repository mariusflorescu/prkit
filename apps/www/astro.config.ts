import { defineConfig, envField, fontProviders } from "astro/config";

/** One latin file of the @fontsource packages the app uses, served by the site itself. */
const fontsource = (
  family: string,
  weight: number,
): { src: [string]; weight: number; style: "normal" } => ({
  src: [`./node_modules/@fontsource/${family}/files/${family}-latin-${weight}-normal.woff2`],
  weight,
  style: "normal",
});

export default defineConfig({
  // Canonical and og:image URLs need the public origin. Unset until prkit has a domain.
  ...(process.env.SITE_URL ? { site: process.env.SITE_URL } : {}),
  env: {
    schema: {
      // Where the GitHub links go. Set it to the public repository when building the site.
      GITHUB_URL: envField.string({
        context: "server",
        access: "public",
        default: "https://github.com",
      }),
    },
  },
  // The favicons are served straight from the brand kit, as in apps/web.
  publicDir: "../../assets/brand/favicon",
  // One page: a separate stylesheet only adds a render-blocking request.
  build: { inlineStylesheets: "always" },
  fonts: [
    {
      provider: fontProviders.local(),
      name: "Fira Sans",
      cssVariable: "--font-sans",
      fallbacks: ["sans-serif"],
      options: {
        variants: [fontsource("fira-sans", 400), fontsource("fira-sans", 500)],
      },
    },
    {
      provider: fontProviders.local(),
      name: "JetBrains Mono",
      cssVariable: "--font-mono",
      fallbacks: ["monospace"],
      options: {
        variants: [fontsource("jetbrains-mono", 400)],
      },
    },
  ],
});
