import { useEffect, useState } from "react";
import { Check, Upload, RotateCcw, Palette } from "lucide-react";
import type { Snapshot, Theme } from "./types";
export default function ThemeEditor({
  state,
  run,
}: {
  state: Snapshot;
  run: (t: string, p?: any) => Promise<any>;
}) {
  const [selected, setSelected] = useState(state.settings.themeId),
    [draft, setDraft] = useState<Theme>(
      state.themes.find((t) => t.id === selected)!,
    );
  useEffect(() => {
    setDraft({ ...state.themes.find((t) => t.id === selected)! });
  }, [selected, state.themes]);
  const colors = [
    "background",
    "surface",
    "raised",
    "accent",
    "secondary",
    "text",
    "muted",
    "border",
  ] as const;
  return (
    <div className="page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>Themes</h1>
          <p className="muted">
            Three worlds. One workspace. Every detail belongs to you.
          </p>
        </div>
        <Palette size={28} />
      </div>
      <div className="theme-choices">
        {state.themes.map((t) => (
          <button
            key={t.id}
            className={"theme-choice " + (selected === t.id ? "selected" : "")}
            style={{
              background: t.surface,
              borderColor: selected === t.id ? t.accent : t.border,
              color: t.text,
            }}
            onClick={() => setSelected(t.id)}
          >
            <img src={t.avatar} alt={t.controller} />
            <strong>{t.name}</strong>
            <span>{t.controller}</span>
            <div className="swatches">
              {[t.background, t.accent, t.secondary].map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </div>
            {state.settings.themeId === t.id && (
              <small>
                <Check size={13} />
                Active theme
              </small>
            )}
          </button>
        ))}
      </div>
      <form
        className="theme-editor panel"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run("theme.save", draft))
            await run("settings", { themeId: selected });
        }}
      >
        <div className="section-heading">
          <h2>Edit {draft.name}</h2>
          <button
            type="button"
            onClick={() => run("theme.reset", { id: selected })}
          >
            <RotateCcw size={15} />
            Restore preset
          </button>
        </div>
        <div className="form-row">
          <label>
            Theme name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
              maxLength={60}
            />
          </label>
          <label>
            Application name
            <input
              value={draft.displayName}
              onChange={(e) =>
                setDraft({ ...draft, displayName: e.target.value })
              }
              required
              maxLength={60}
            />
          </label>
          <label>
            Controller name
            <input
              value={draft.controller}
              onChange={(e) =>
                setDraft({ ...draft, controller: e.target.value })
              }
              required
              maxLength={60}
            />
          </label>
        </div>
        <div className="color-fields">
          {colors.map((k) => (
            <label key={k}>
              {k[0].toUpperCase() + k.slice(1)}
              <div>
                <input
                  aria-label={`${k} color`}
                  type="color"
                  value={draft[k]}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                />
                <span>{draft[k].toUpperCase()}</span>
              </div>
            </label>
          ))}
        </div>
        <label className="upload">
          <Upload size={17} />
          Choose controller icon / image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 2e6) {
                alert("Choose an image smaller than 2 MB.");
                return;
              }
              const reader = new FileReader();
              reader.onload = () =>
                setDraft({ ...draft, avatar: String(reader.result) });
              reader.readAsDataURL(file);
            }}
          />
        </label>
        <label className="upload">
          <Upload size={17} />
          Choose environment background
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 14e6) {
                alert("Choose an image smaller than 14 MB.");
                return;
              }
              const reader = new FileReader();
              reader.onload = () =>
                setDraft({ ...draft, backdrop: String(reader.result) });
              reader.readAsDataURL(file);
            }}
          />
        </label>
        {draft.backdrop && (
          <button
            type="button"
            onClick={() => setDraft({ ...draft, backdrop: "" })}
          >
            Clear background
          </button>
        )}
        <div
          className="theme-preview"
          style={{
            backgroundColor: draft.background,
            backgroundImage: draft.backdrop
              ? `linear-gradient(${draft.background}bb,${draft.background}bb),url("${draft.backdrop}")`
              : undefined,
            backgroundSize: "cover",
            backgroundPosition: "center",
            color: draft.text,
            borderColor: draft.border,
          }}
        >
          <img src={draft.avatar} alt="Controller preview" />
          <div>
            <small style={{ color: draft.muted }}>CONTROLLER PREVIEW</small>
            <h2>{draft.controller}</h2>
            <p style={{ color: draft.accent }}>
              {draft.displayName} · Ready when you are.
            </p>
          </div>
        </div>
        <footer>
          <span className="muted small">
            Project viewers can use their own theme.
          </span>
          <button className="primary">
            Save and apply theme
            <Check size={16} />
          </button>
        </footer>
      </form>
    </div>
  );
}
