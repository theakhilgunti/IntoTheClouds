import Link from "next/link";
import LocateForm from "@/components/home/LocateForm";

const steps = [
  { n: "1", t: "Show us the house", d: "A photo or a street address." },
  { n: "2", t: "We identify it", d: "Map data + vision AI find the exact building." },
  { n: "3", t: "Get the 3D layout", d: "Floors, rooms, stairs and exits — before you go in." },
];

export default function Home() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-neutral-950 px-4 pb-10 text-white">
      {/* blueprint grid + glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(#facc15 1px, transparent 1px), linear-gradient(90deg, #facc15 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage: "radial-gradient(ellipse at 50% 30%, black 20%, transparent 75%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-12rem] h-[28rem] w-[44rem] -translate-x-1/2 rounded-full bg-yellow-400/10 blur-3xl"
      />

      <header className="relative z-10 flex w-full max-w-5xl items-center justify-between py-5">
        <span className="text-xl font-black tracking-tight">
          Cloud<span className="text-yellow-400">Scan</span>
        </span>
        <Link
          href="/model/demo"
          className="text-sm font-semibold text-neutral-400 underline-offset-4 hover:text-white hover:underline"
        >
          Skip → view demo
        </Link>
      </header>

      <section className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 py-8 text-center">
        <div className="space-y-4">
          <p className="inline-block rounded-full border border-yellow-400/30 bg-yellow-400/10 px-4 py-1 text-xs font-bold uppercase tracking-[0.25em] text-yellow-300">
            HackRPI · Into The Clouds
          </p>
          <h1 className="text-balance text-4xl font-black leading-tight sm:text-6xl">
            See inside any building
            <br />
            <span className="text-yellow-400">before you step in.</span>
          </h1>
          <p className="mx-auto max-w-lg text-pretty text-lg text-neutral-400">
            Give us a photo or an address. CloudScan builds an interactive 3D layout in seconds.
          </p>
        </div>

        <LocateForm />

        <ol className="mt-4 grid w-full max-w-3xl gap-3 text-left sm:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-yellow-400 text-sm font-black text-black">
                {s.n}
              </span>
              <p className="mt-3 font-bold">{s.t}</p>
              <p className="mt-1 text-sm text-neutral-400">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
