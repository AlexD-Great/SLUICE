/** @type {import('next').NextConfig} */
const nextConfig = {
  // The template shipped with type errors suppressed. This app moves money, so
  // a build that typechecks is worth more than a build that always succeeds.
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
