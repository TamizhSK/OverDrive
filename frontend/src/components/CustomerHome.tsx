import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUpRight,
  ClipboardList,
  ShieldCheck,
  Smartphone,
  Snowflake,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";
import type { Ticket } from "@servicecare/contracts";
import { api, type TicketOverview } from "../lib/api";
import { supportTopics, supportImages, ticketCounts } from "../lib/support";

const icons = {
  phone: Smartphone,
  wrench: Wrench,
  charging: Zap,
  climate: Snowflake,
  shield: ShieldCheck,
  warning: ShieldCheck,
};

export function CustomerHome({ tickets }: Readonly<{ tickets: Ticket[] }>) {
  const [overview, setOverview] = useState<TicketOverview>();
  useEffect(() => {
    let active = true;
    void api.customerOverview().then(result => { if (active) setOverview(result); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const counts = overview ?? ticketCounts(tickets);
  return (
    <div className="customer-home">
      <section className="home-feature-band">
        <img
          src={supportImages.workshop}
          alt="BMW coupe overlooking the mountains at sunset"
          fetchPriority="high"
        />
        <div>
          <span>OVERDRIVE</span>
          <h1>
            Your BMW.
            <br />
            In good hands.
          </h1>
          <p>Confidence for the road ahead.</p>
          <a className="button primary" href="#home-topics">
            Find support
            <ArrowDown size={18} />
          </a>
        </div>
      </section>
      <section className="home-service-status" aria-label="My service overview">
        <div>
          <ClipboardList size={22} />
          <div>
            <strong>{counts.open.toString().padStart(2, "0")}</strong>
            <span>Open requests</span>
          </div>
        </div>
        <div>
          <Timer size={22} />
          <div>
            <strong>
              {tickets
                .filter((ticket) => ticket.status === "IN_PROGRESS")
                .length.toString()
                .padStart(2, "0")}
            </strong>
            <span>In progress</span>
          </div>
        </div>
      </section>
      <section className="home-topics" id="home-topics">
        <div className="home-section-heading">
          <div>
            <span className="section-kicker">LET'S FIND THE RIGHT HELP</span>
            <h2>What is your concern about?</h2>
            <p>
              Choose a category to see related issues in your Overdrive
              conversation.
            </p>
          </div>
        </div>
        <div className="home-topic-grid">
          {supportTopics.map((topic) => {
            const Icon = icons[topic.icon];
            return (
              <Link to={`/service-assistant?topic=${topic.id}`} key={topic.id}>
                <Icon size={24} />
                <div>
                  <h3>{topic.title}</h3>
                  <p>{topic.description}</p>
                </div>
                <ArrowUpRight size={17} />
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
