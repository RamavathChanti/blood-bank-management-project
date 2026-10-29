import { RequestIntake } from "@/components/request-intake";
import { OpsCopilot } from "@/components/ops-copilot";
export const metadata = { title: "Intelligence Lab" };
export default function Page() { return <><div className="page-heading"><div><p className="eyebrow">EXTRAS / HUMAN REVIEW</p><h1>Intelligence Lab</h1><p className="page-description">Inspect extraction uncertainty and bounded forecast answers.</p></div></div><RequestIntake /><OpsCopilot /></>; }
