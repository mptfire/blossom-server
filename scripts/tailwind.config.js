/** Tailwind content config for the precompiled stylesheet (public/tw.css).
 * Replaces the cdn.tailwindcss.com runtime script, which executed a
 * third-party script with full page privileges on the landing and /files
 * pages (r8 senior review, privacy finding). Regenerate after any class
 * change:  scripts/gen-css.sh  — commit the regenerated public/tw.css.
 * Uses the same version as the removed CDN runtime (v3.4.17). */
module.exports = {
  content: [
    "./src/**/*.tsx",
    "./src/**/*.ts",
    "!./src/**/node_modules/**",
  ],
  corePlugins: { preflight: true },
};
