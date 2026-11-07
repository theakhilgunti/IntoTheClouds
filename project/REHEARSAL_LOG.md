# Rehearsal Kit and Log (IN-04, GitHub issue #26)

Run the whole demo **twice, from a cold start**, with the whole team, about T+22h. Fix or document every failure. We pass when we get **two clean runs in a row**.

Fill in the **bracketed choices** once the team has decided them (Pi + iPhone, or iPhone only). Delete the lines that do not apply.

---

## 1. Before you start

**Roles** (one person each, write names in):

| Role | Name | Job |
| :-- | :-- | :-- |
| Walker | | Wears the rig, blindfolded for the walk |
| Spotter | | Walks beside the walker for safety. Clears the path. |
| Operator | | Runs the laptop and dashboard, calls out each setup step |
| Timekeeper | | Runs the stopwatch and writes in the log |
| Narrator | | Gives the pitch lines from `PITCH_OUTLINE.md` |

**Safety:** the blindfolded walk needs a clear floor, no cables across the path, and the spotter within arm's reach. Stop the run if anyone is unsure.

**Prerequisites (do not rehearse until these are true):**
- [ ] Priority-1 tasks are done or consciously dropped (see `project/WORK_ORDERS.md`)
- [ ] `project/DEMO_GUIDE.md` is up to date (IN-02)
- [ ] A replay recording exists and works (IN-03)
- [ ] The team has agreed the rig: [Pi + iPhone / iPhone only]
- [ ] Everything is charged and installed while you still have internet (see NET-01, issue #27)

## 2. Cold start (timer starts at "go")

Everything powered **off**, dashboard closed, anchor hotspots off. The Operator reads the steps aloud from `DEMO_GUIDE.md`. Nobody types a command that is not in the guide. **Target: ready in under 10 minutes.**

| # | Step | Done | Time |
| :-- | :-- | :-- | :-- |
| 1 | Place and power anchor laptops, start hotspots (`ITC-A1`..`A3`), lids open, sleep off | [ ] | |
| 2 | Start the backend (`./scripts/run-backend.sh`) | [ ] | |
| 3 | Start the dashboard (`cd project/frontend && npm run dev`) | [ ] | |
| 4 | Dashboard shows the right anchors in the right places | [ ] | |
| 5 | [Pi + iPhone] Pi powered from a power bank and linked by cable | [ ] | |
| 6 | iPhone opens the phone page, taps Start, allows motion | [ ] | |
| 7 | Marker is **steady for 15 seconds** while the rig stands still | [ ] | |
| 8 | **READY.** Stop the setup timer. | [ ] | |

## 3. The demo run (follow `DEMO_GUIDE.md`)

Timekeeper records the time of each part. Target total for the pitch: **3 minutes**.

| Part | What happens | Target | Actual | OK? |
| :-- | :-- | :-- | :-- | :-- |
| Anchors | Show the anchors on the dashboard | 30 s | | [ ] |
| Blindfolded walk | Walker crosses the room; marker follows | 60 s | | [ ] |
| Voice hazard | Walker says "fire"; a hazard pin appears at their position | 45 s | | [ ] |
| Close | Wrap up and state the honest limits | 45 s | | [ ] |

(The wall-outline part of the old guide is stretch work. Include it only if BE-01 to BE-03 and FE-01 are done.)

**Pass check for the walk:** the marker follows the walker, ends within about 2 m of where they really stopped, and no error appears on screen.

## 4. Failure drills (do these in the **second** rehearsal, once it works cleanly)

| Drill | How to cause it | What we should do | Worked? |
| :-- | :-- | :-- | :-- |
| An anchor disappears | Close one anchor laptop's lid | Notice it, say so, carry on or reset | [ ] |
| Marker freezes | Unplug the cable or stop the phone page | Restart the source in under 30 s | [ ] |
| Wi-Fi too noisy | Declare it | **Switch to replay** (IN-03) in under 30 s, and tell the judges it is a replay | [ ] |
| Voice not recognised | Use a noisy room | Use the manual hazard button | [ ] |
| Laptop sleeps | Wait for it | Wake it, confirm the hotspot is still on | [ ] |

## 5. Rehearsal log

Add one row per problem. Write what you saw, not what you guess.

| Run | Time to ready | What went wrong | Fix or workaround | Fixed? |
| :-- | :-- | :-- | :-- | :-- |
| 1 | | | | |
| 1 | | | | |
| 2 | | | | |

## 6. Result

| Run | Setup time | Demo time | Walk end error (m) | Clean? (no failures, no help needed) |
| :-- | :-- | :-- | :-- | :-- |
| 1 | | | | [ ] |
| 2 | | | | [ ] |

**Done when (from issue #26):**
- [ ] Two clean runs in a row, from cold start
- [ ] Every failure above has a fix or a written workaround
- [ ] Everyone on the team can run the demo without help (each person has done at least one role)
- [ ] The pitch fits in 3 minutes

## 7. Honest wording (use in the pitch)

- Wi-Fi positioning is **meter-level at best**: say "approximate position".
- If any part is a recording, say **"this is a replay"** before showing it.
- Do not claim field readiness. Smoke and heat have not been tested.
