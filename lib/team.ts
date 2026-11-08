/** HackRPI CloudScan teammates — fill in names + LinkedIn URLs when ready. */
export type Teammate = {
  name: string;
  role?: string;
  /** Full LinkedIn profile URL. Empty → name shown without a link yet. */
  linkedin: string;
  /** Optional headshot path under /public or absolute URL. */
  headshot?: string;
};

export const TEAM: Teammate[] = [
  {
    name: "Akhil Gunti",
    role: "Builder",
    linkedin: "https://www.linkedin.com/in/theakhilgunti/",
    headshot: "/team/akhil-gunti.jpg",
  },
  {
    name: "Joshua Okwuabueze",
    role: "Builder",
    linkedin: "https://www.linkedin.com/in/joshuaokwuabueze/",
    headshot: "/team/joshua-okwuabueze.jpg",
  },
  {
    name: "Prem Bagul",
    role: "Builder",
    linkedin: "https://www.linkedin.com/in/prem-bagul/",
    headshot: "/team/prem-bagul.jpg",
  },
  {
    name: "Caleb Meade",
    role: "Builder",
    linkedin: "https://www.linkedin.com/in/caleb-meade-66117739a/",
    headshot: "/team/caleb-meade.jpg",
  },
];
