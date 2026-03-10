import nextConfig from "eslint-config-next";

export default [
  ...nextConfig,
  {
    rules: {
      // setMounted(true) in useEffect is intentional for hydration safety in App Router
      "react-hooks/set-state-in-effect": "off",
      // React Compiler rules — project doesn't use reactCompiler, disable these
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/static-components": "off",
      // Allow <img> — project uses dynamic image sources (IPFS, dicebear, user uploads)
      "@next/next/no-img-element": "off",
      // Allow anonymous default exports
      "import/no-anonymous-default-export": "off",
    },
  },
];
