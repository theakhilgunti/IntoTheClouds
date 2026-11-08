import Link from "next/link";
import SideClouds from "@/components/home/SideClouds";
import { TEAM, type Teammate } from "@/lib/team";

export const metadata = {
  title: "Meet the Team · CloudScan",
  description: "The four builders behind CloudScan at HackRPI.",
};

export default function AboutPage() {
  return (
    <main className="bp-sheet relative flex min-h-dvh flex-col items-center overflow-hidden px-5 pb-10">
      <SideClouds />

      <header className="relative z-10 flex w-full max-w-5xl items-center justify-between py-5">
        <Link
          href="/"
          className="font-display text-2xl uppercase tracking-[0.14em] transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-bp-red"
        >
          Cloud<span className="text-bp-red">Scan</span>
        </Link>
        <Link
          href="/"
          className="font-data text-xs underline decoration-bp-ink underline-offset-4 hover:text-bp-red hover:decoration-bp-red"
        >
          ← Home
        </Link>
      </header>

      <section className="relative z-10 flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8 py-8 text-center">
        <div className="space-y-3">
          <p className="font-data text-[11px] uppercase tracking-[0.22em] text-bp-line">HackRPI</p>
          <h1 className="font-display text-5xl uppercase leading-[0.94] tracking-[0.02em] text-white sm:text-6xl">
            Meet the <span className="text-bp-red">team</span>
          </h1>
          <p className="mx-auto max-w-md font-data text-sm leading-relaxed text-bp-ink/85">
            Four builders behind CloudScan — tactical 3D mapping for first responders.
          </p>
        </div>

        <ul className="grid w-full gap-3 sm:grid-cols-2">
          {TEAM.map((person) => (
            <li key={person.name}>
              <TeammateCard person={person} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function TeammateCard({ person }: { person: Teammate }) {
  const linked = Boolean(person.linkedin.trim());
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  const inner = (
    <>
      <div className="flex w-full items-start gap-4">
        {person.headshot ? (
          // eslint-disable-next-line @next/next/no-img-element -- local/public headshots; keep simple
          <img
            src={person.headshot}
            alt=""
            width={72}
            height={72}
            className="h-[72px] w-[72px] shrink-0 border border-bp-ink/50 object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-[72px] w-[72px] shrink-0 items-center justify-center border border-bp-ink/40 bg-bp/40 font-display text-lg tracking-wider text-bp-line"
          >
            {initials || "?"}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 pt-0.5">
          <span className="font-display text-2xl uppercase tracking-[0.06em] text-white">{person.name}</span>
          {person.role ? (
            <span className="font-data text-[11px] uppercase tracking-[0.16em] text-bp-line">{person.role}</span>
          ) : null}
        </div>
      </div>
      <span className={`font-data text-xs ${linked ? "text-bp-red" : "text-bp-line/70"}`}>
        {linked ? "LinkedIn →" : "LinkedIn soon"}
      </span>
    </>
  );

  const shell =
    "flex min-h-[7.5rem] flex-col items-start justify-between gap-3 border border-bp-ink/55 bg-bp-deep/55 px-5 py-4 text-left transition";

  if (linked) {
    return (
      <a
        href={person.linkedin}
        target="_blank"
        rel="noopener noreferrer"
        className={`${shell} hover:border-bp-red hover:bg-bp-deep/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bp-red`}
      >
        {inner}
      </a>
    );
  }

  return <div className={shell}>{inner}</div>;
}
