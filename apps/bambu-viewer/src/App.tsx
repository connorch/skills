// The Review Page layout: the Model fills the viewport; a dock along the
// bottom holds the view tiles, the Printability Report and the print details,
// each a headline, one key line, and a popover for the rest.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LoadedModel } from "./model.ts";
import type { Check, Review } from "./review.ts";
import { type Insets, Stage, Tile, type ViewName, type ViewRequest } from "./scene/index.ts";

const VIEWS: { name: ViewName; label: string }[] = [
  { name: "iso", label: "3D" },
  { name: "front", label: "Front" },
  { name: "side", label: "Side" },
  { name: "top", label: "Top" },
];

const fmt = (n: number) => n.toFixed(1);

function initialView(): ViewName {
  const wanted = new URLSearchParams(location.search).get("view");
  return VIEWS.some((v) => v.name === wanted) ? (wanted as ViewName) : "iso";
}

export function App({ review, model }: { review: Review; model: LoadedModel }) {
  const [view, setView] = useState<ViewRequest>({ name: initialView(), nonce: 0 });
  // The tile that matches the camera; cleared once the user orbits by hand.
  const [selected, setSelected] = useState<ViewName | null>(view.name);
  const [insets, setInsets] = useState<Insets>({ top: 90, bottom: 0, left: 0, right: 0 });
  const dock = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  // Which dock popover is open, if any; both columns share it so only one shows.
  const [open, setOpen] = useState<string | null>(null);

  // The dock overlays the canvas on wide screens and stacks below it on
  // phones; the camera only needs to avoid it in the first case.
  useLayoutEffect(() => {
    const phone = matchMedia("(max-width: 700px)");
    const measure = () =>
      setInsets({
        top: 90,
        left: 0,
        right: 0,
        bottom: phone.matches ? 0 : (dock.current?.offsetHeight ?? 0) - 24,
      });
    measure();
    const observer = new ResizeObserver(measure);
    if (dock.current) observer.observe(dock.current);
    phone.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      phone.removeEventListener("change", measure);
    };
  }, []);

  const color = review.print?.filament?.hex ?? "#8fa3c7";
  const [sx, sy, sz] = review.model.size;

  return (
    <>
      <div className="stage">
        <Stage
          model={model}
          plate={review.printer.plate}
          color={color}
          view={view}
          insets={insets}
          labels={labels}
          onUserOrbit={() => setSelected(null)}
        />
        <div className="labels" ref={labels}>
          <span className="dimlabel x" data-axis="x">
            {fmt(sx)}
          </span>
          <span className="dimlabel y" data-axis="y">
            {fmt(sy)}
          </span>
          <span className="dimlabel z" data-axis="z">
            {fmt(sz)}
          </span>
        </div>
      </div>

      <header className="head">
        <div>
          <div className="job">{review.job}</div>
          <h1>{review.title}</h1>
          <Source review={review} />
        </div>
        <div className="dims">
          <i className="x">X</i>
          {fmt(sx)}
          <i className="y">Y</i>
          {fmt(sy)}
          <i className="z">Z</i>
          {fmt(sz)} mm
        </div>
      </header>

      <div className="dock" ref={dock}>
        <nav className="tiles">
          {VIEWS.map((v) => (
            <button
              key={v.name}
              className={`tile${selected === v.name ? " on" : ""}`}
              onClick={() => {
                setView((prev) => ({ name: v.name, nonce: prev.nonce + 1 }));
                setSelected(v.name);
              }}
            >
              <Tile model={model} view={v.name} color={color} />
              <span className="cap">
                <b>{v.label}</b>
              </span>
            </button>
          ))}
        </nav>
        <ReportColumn review={review} open={open} setOpen={setOpen} />
        <PrintColumn review={review} open={open} setOpen={setOpen} />
      </div>
    </>
  );
}

function Source({ review }: { review: Review }) {
  const s = review.source;
  if (!s) return <div className="src">{review.model.file}</div>;
  const site = s.url ? <a href={s.url}>{s.site ?? s.url}</a> : s.site;
  return (
    <div className="src">
      {s.author ? `by ${s.author}` : s.route}
      {site ? <> on {site}</> : null}
      {s.license ? ` · ${s.license}` : ""}
    </div>
  );
}

// One popover open at a time; a click anywhere else closes it.
function usePopover(name: string, open: string | null, setOpen: (v: string | null) => void) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (open === name && ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [name, open, setOpen]);
  return {
    ref,
    open: open === name,
    onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      if (e.currentTarget.open) setOpen(name);
      else if (open === name) setOpen(null);
    },
  };
}

interface ColumnProps {
  review: Review;
  open: string | null;
  setOpen: (v: string | null) => void;
}

function ReportColumn({ review, open, setOpen }: ColumnProps) {
  const popover = usePopover("checks", open, setOpen);
  const r = review.report;
  if (!r) return <div className="col" />;
  const issues = r.checks.filter((c) => c.status !== "ok");
  return (
    <div className="col">
      <div className="big">
        <span className="n">
          {r.score}
          <span>/10</span>
        </span>
        <span className="t">
          {issues.length
            ? `${r.checks.length - issues.length} of ${r.checks.length} checks pass`
            : "All checks pass"}
        </span>
      </div>
      <div>
        {issues.length ? (
          issues.map((c) => (
            <div className="line" key={c.key} title={c.detail}>
              <i className={`dot ${c.status}`} />
              <span>{c.label}</span>
              <span className="warn-v">{c.value}</span>
              <span className="rest">{c.detail}</span>
            </div>
          ))
        ) : (
          <div className="line">
            <i className="dot ok" />
            <span className="rest">Nothing to fix before printing</span>
          </div>
        )}
      </div>
      <details {...popover}>
        <summary>All {r.checks.length} checks</summary>
        <div className="pop">
          <ul>
            {r.checks.map((c: Check) => (
              <li key={c.key} className={c.status} title={c.detail}>
                <i className={`dot ${c.status}`} />
                <span className="k">{c.label}</span>
                <span className="v">{c.value}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function PrintColumn({ review, open, setOpen }: ColumnProps) {
  const popover = usePopover("print", open, setOpen);
  const p = review.print;
  if (!p) return <div className="col" />;
  const est = p.estimate;
  const fil = p.filament;
  const settings = Object.fromEntries(p.settings);
  const summary = [settings.Layer && `${settings.Layer} layers`, settings.Plate]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="col">
      <div className="big">
        {est ? (
          <>
            <span className="n">
              {est.minutes >= 60 ? `${Math.floor(est.minutes / 60)}` : `${est.minutes}`}
              <span> {est.minutes >= 60 ? `h ${est.minutes % 60} min` : "min"}</span>
            </span>
            <span className="t">
              {est.grams} g{fil ? ` of ${fil.name}` : ""}
            </span>
          </>
        ) : (
          <span className="t">Not sliced yet</span>
        )}
      </div>
      {review.palette ? (
        <div className="line palette">
          {review.palette.map((c) => (
            <span key={c.slot} title={`${c.name} · ${c.areaPct.toFixed(0)}%`}>
              <span className="swatch" style={{ background: c.hex }} /> {c.slot}
            </span>
          ))}
        </div>
      ) : fil ? (
        <div className="line">
          <span className="swatch" style={{ background: fil.hex }} />
          <span>
            {fil.name} {fil.color}
          </span>
          <span className="rest">Slot {fil.slot}</span>
        </div>
      ) : (
        <div className="line">
          <span className="rest">No filament chosen</span>
        </div>
      )}
      <details {...popover}>
        <summary>{summary || "Print settings"}</summary>
        <div className="pop">
          <dl>
            {p.settings.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </details>
    </div>
  );
}
