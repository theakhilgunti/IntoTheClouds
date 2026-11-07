import Link from "next/link";

// Placeholder landing page — Person B builds the full version (hero, how it works, roadmap, team).
export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-neutral-950 px-4 text-center text-white">
      <p className="text-sm font-bold uppercase tracking-[0.3em] text-yellow-400">HackRPI · Into The Clouds</p>
      <h1 className="text-5xl font-black sm:text-7xl">CloudScan</h1>
      <p className="max-w-xl text-lg text-neutral-300">
        Point your phone at a building. Get a 3D layout of its floors, rooms, stairs and exits before you go in.
      </p>
      <Link
        href="/model/demo"
        className="min-h-12 rounded-lg bg-yellow-400 px-8 py-3 text-lg font-bold uppercase tracking-wide text-black hover:bg-yellow-300"
      >
        Open demo model
      </Link>
    </main>
  );
}
