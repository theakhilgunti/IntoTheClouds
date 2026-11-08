import Link from "next/link";
import LocateForm from "@/components/home/LocateForm";
import OpenHouse from "@/components/home/OpenHouse";
import StepStrip from "@/components/home/StepStrip";

export default function Home() {
  return (
    <main className="bp-sheet flex min-h-dvh flex-col items-center px-5 pb-8">
      <header className="flex w-full max-w-5xl items-center justify-between py-5">
        <span className="font-display text-2xl uppercase tracking-[0.14em]">
          Cloud<span className="text-bp-red">Scan</span>
        </span>
        <Link
          href="/model/demo"
          className="font-data text-xs underline decoration-bp-ink underline-offset-4 hover:text-bp-red hover:decoration-bp-red"
        >
          Demo →
        </Link>
      </header>

      <section className="flex w-full flex-1 flex-col items-center justify-center gap-4 text-center">
        <h1 className="font-display text-5xl uppercase leading-[0.94] tracking-[0.02em] text-white sm:text-7xl">
          See the plan.
          <br />
          <span className="text-bp-red">Then go in.</span>
        </h1>

        <OpenHouse />

        <LocateForm />

        <StepStrip />
      </section>
    </main>
  );
}
