import { useState } from "react";
import { CircleHelp, Check, ArrowRight, Plus, Clock } from "lucide-react";
import type { Snapshot, Question } from "./types";
import { Modal } from "./Dialogs";
export default function Questions({
  state,
  run,
}: {
  state: Snapshot;
  run: (t: string, p?: any) => Promise<any>;
}) {
  const [filter, setFilter] = useState("pending"),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [adding, setAdding] = useState(false),
    [text, setText] = useState(""),
    [area, setArea] = useState("General"),
    [projectId, setProjectId] = useState("");
  const list = state.questions
    .filter((q) => filter === "all" || q.status === filter)
    .slice()
    .reverse();
  const project = (q: Question) =>
    state.projects.find((p) => p.id === q.projectId)?.name || "Alpha";
  return (
    <div className="page questions-page">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ONE PLACE TO ANSWER</span>
          <h1>Questions</h1>
          <p className="muted">
            Every project. Every window. Your answers, delivered to the right
            place.
          </p>
        </div>
        <button onClick={() => setAdding(true)}>
          <Plus size={16} />
          Add question
        </button>
      </div>
      <div className="tabbar">
        {["pending", "answered", "resolved", "all"].map((f) => (
          <button
            key={f}
            className={filter === f ? "active" : ""}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
            <span className="count">
              {
                state.questions.filter((q) => f === "all" || q.status === f)
                  .length
              }
            </span>
          </button>
        ))}
      </div>
      {!list.length ? (
        <div className="empty">
          <CircleHelp size={42} />
          <h2>
            {filter === "pending"
              ? "Nothing waiting on you"
              : "No questions here yet"}
          </h2>
          <p>
            Questions raised by agents and project areas appear here
            automatically.
          </p>
        </div>
      ) : (
        <div className="question-list">
          {list.map((q) => (
            <article key={q.id} className="question-card">
              <div className="question-meta">
                <span className={"status " + q.status}>
                  {q.status === "pending" ? (
                    <Clock size={13} />
                  ) : (
                    <Check size={13} />
                  )}{" "}
                  {q.status}
                </span>
                <span>
                  {project(q)} / {q.area}
                </span>
                <time>{new Date(q.created).toLocaleString()}</time>
              </div>
              <h2>{q.text}</h2>
              {q.context && <p className="question-context">{q.context}</p>}
              <div className="muted small">
                From{" "}
                {state.sessions.find((s) => s.id === q.requester)?.title ||
                  q.area}
              </div>
              {q.status === "pending" ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run("question.answer", {
                        id: q.id,
                        answer: answers[q.id],
                      })
                    )
                      setAnswers((a) => ({ ...a, [q.id]: "" }));
                  }}
                >
                  {!!q.options.length && (
                    <div className="answer-options">
                      {q.options.map((option) => (
                        <button
                          type="button"
                          key={option}
                          onClick={() =>
                            setAnswers((a) => ({ ...a, [q.id]: option }))
                          }
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                  <label>
                    Your answer
                    <textarea
                      required
                      rows={3}
                      value={answers[q.id] || ""}
                      onChange={(e) =>
                        setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                      }
                      placeholder="Write your answer, or choose a suggestion and edit it."
                    />
                  </label>
                  <footer>
                    <span className="muted small">
                      Saved only when you submit.
                    </span>
                    <button className="primary">
                      Send answer
                      <ArrowRight size={16} />
                    </button>
                  </footer>
                </form>
              ) : (
                <div className="saved-answer">
                  <span className="eyebrow">YOUR ANSWER</span>
                  <p>{q.answer}</p>
                  <div className="row-between">
                    <small className="muted">
                      {q.answeredAt && new Date(q.answeredAt).toLocaleString()}{" "}
                      · Available to requester
                    </small>
                    {q.status === "answered" && (
                      <button
                        onClick={() => run("question.resolve", { id: q.id })}
                      >
                        <Check size={15} />
                        Mark resolved
                      </button>
                    )}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {adding && (
        <Modal title="Add question" onClose={() => setAdding(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run("question.create", {
                  text,
                  area,
                  projectId: projectId || null,
                })
              ) {
                setAdding(false);
                setText("");
                setFilter("pending");
              }
            }}
          >
            <label>
              Question
              <textarea
                autoFocus
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
              />
            </label>
            <label>
              Area
              <input
                value={area}
                onChange={(e) => setArea(e.target.value)}
                required
              />
            </label>
            <label>
              Project
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Alpha</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <footer>
              <button className="primary">Add to Questions</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
