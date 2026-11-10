import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Headphones,
  MessageCircle,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Send,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AssistantAnswer, ChatContext } from "@servicecare/contracts";
import { api } from "../lib/api";
import { demoMode } from "../lib/auth";
import { problemDescription, requestDraft, supportTopics, topicById } from "../lib/support";
import { validateChatImage } from "../lib/images";
import { visualEnabled } from "../lib/visual";
import { VisualSupport } from "./VisualSupport";
import { chatAnswer, sameChatConcern } from '../lib/chat';

const answerHeadings: Record<AssistantAnswer["source"], string> = {
  "local-faq": "Demonstration guidance",
  bedrock: "From the Knowledge Base",
  agentcore: "From the Knowledge Base",
  "safety-rule": "Overdrive response",
  unavailable: "Overdrive response",
};
const resolvableSources = new Set<AssistantAnswer['source']>(['local-faq', 'bedrock', 'agentcore']);

function conversationView(answer: AssistantAnswer) {
  const critical = answer.triage.critical;
  let route = "Knowledge base";
  if (critical) route = "Safety stop";
  if (answer?.source === "unavailable") route = "Advisor review";
  return {
    critical,
    route,
    heading: answerHeadings[answer.source],
    question: answer.question,
    text: answer.answer,
    citations: answer.citations,
    canResolve: !critical && resolvableSources.has(answer.source),
  };
}

export function ConversationResult({
  answer,
  resolved,
  busy,
  onResolved,
  onRequest,
  onUnresolved,
  onAnalyzePhotos,
  onClose,
  archived = false,
}: Readonly<{
  answer: AssistantAnswer;
  resolved: boolean;
  busy: boolean;
  onResolved: () => void;
  onRequest: () => void;
  onUnresolved: () => void;
  onAnalyzePhotos?: () => void;
  onClose: () => void;
  archived?: boolean;
}>) {
  const [rating, setRating] = useState<"helpful" | "not-helpful">();
  const view = conversationView(answer);
  let resolutionText = '';
  if (answer.reason === 'no-alternative') resolutionText = 'The available guidance has not resolved this concern.';
  else if (!view.canResolve) resolutionText = 'Your service advisor can review the concern.';
  return (
    <article className="support-response" aria-live="polite">
      <div className="support-customer-message">
        <MessageSquare size={18} />
        <p>{view.question}</p>
      </div>
      <div className="response-author">
        <span className="support-agent-icon">
          <Headphones size={20} />
        </span>
        <div>
          <strong>Overdrive</strong>
          <span>{view.heading}</span>
        </div>
      </div>
      {view.critical && (
        <div className="alert safety" role="alert">
          <ShieldAlert size={20} />
          <strong>
            Safety concern. Please contact official roadside assistance or
            emergency services if there is immediate danger.
          </strong>
        </div>
      )}
      <div className="response-body">
        <p>{view.text}</p>
        {view.citations.length > 0 && (
          <details className="response-sources">
            <summary>
              <BookOpen size={15} />
              Sources ({view.citations.length})
            </summary>
            {view.citations.map((citation, index) => (
              <p key={`${citation.reference}-${index}`}>
                {citation.title}
                <small>{answer.source === 'local-faq' ? 'Demonstration reference' : 'Bedrock Knowledge Base · Indexed document'}</small>
              </p>
            ))}
          </details>
        )}
      </div>
      {!archived &&
        (resolved ? (
          <div className="closed-conversation">
            <output className="resolution-confirmation">
              <Check size={21} />
              <div>
                <strong>Your issue is resolved.</strong>
                <p>No service request was created.</p>
              </div>
            </output>
            <button className="button primary" onClick={onClose}>
              Close conversation
              <Check size={16} />
            </button>
          </div>
        ) : (
          <>
            {view.canResolve && answer.nextAction !== 'offer-ticket' && <div className="answer-rating">
              <span>Was this answer helpful?</span>
              <div>
                <button
                  aria-pressed={rating === "helpful"}
                  disabled={busy}
                  onClick={() => setRating("helpful")}
                >
                  <ThumbsUp size={16} />
                  Helpful
                </button>
                <button
                  aria-pressed={rating === "not-helpful"}
                  disabled={busy}
                  onClick={() => { setRating("not-helpful"); onUnresolved(); }}
                >
                  <ThumbsDown size={16} />
                  Not helpful
                </button>
              </div>
            </div>}
            <section className="resolution-actions">
              <h3>
                {view.canResolve && answer.nextAction !== 'offer-ticket' ? 'Has your issue been resolved?' : 'Advisor review'}
              </h3>
              <p>
                {resolutionText}
              </p>
              <div>
                {view.canResolve && answer.nextAction !== 'offer-ticket' && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={onResolved}
                  >
                    <Check size={16} />
                    Yes, resolved
                  </button>
                )}
                {(!view.canResolve || answer.nextAction === 'offer-ticket') ? <button
                  className="button primary"
                  disabled={busy}
                  onClick={onRequest}
                >
                  Create a service request
                  <ArrowRight size={16} />
                </button> : <button className="button secondary" disabled={busy} onClick={onUnresolved}><ThumbsDown size={16} />Still unresolved</button>}
                {onAnalyzePhotos && (!view.canResolve || answer.nextAction === 'offer-ticket') && <button className="button secondary" disabled={busy} onClick={onAnalyzePhotos}><Paperclip size={16} />Analyze attached photos</button>}
              </div>
            </section>
          </>
        ))}
    </article>
  );
}

export function Assistant() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AssistantAnswer>();
  const [sentMessage, setSentMessage] = useState('');
  const [activeIssue, setActiveIssue] = useState('');
  const [triedAnswers, setTriedAnswers] = useState<string[]>([]);
  const inFlight = useRef(false);
  const [history, setHistory] = useState<AssistantAnswer[]>([]);
  const [commonOpen, setCommonOpen] = useState(true);
  const [images, setImages] = useState<
    { id: string; file: File; url: string }[]
  >([]);
  const imagesRef = useRef(images);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const [resolved, setResolved] = useState(false);
  const [visualOpen, setVisualOpen] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const topic = topicById(searchParams.get("topic") ?? "connectivity");
  const canResolve = Boolean(
    answer &&
      !answer.triage.critical &&
      resolvableSources.has(answer.source),
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(
    () => () => {
      imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
    },
    [],
  );
  useEffect(() => {
    if (answer || busy)
      transcript.current?.scrollTo({
        top: transcript.current.scrollHeight,
        behavior: "smooth",
      });
  }, [answer, busy, images.length]);

  function chooseTopic(id: string) {
    setSearchParams({ topic: id }, { replace: true });
    setCommonOpen(true);
    setActiveIssue('');
    setTriedAnswers([]);
  }

  function removeImage(id: string) {
    const image = images.find((item) => item.id === id);
    if (image) URL.revokeObjectURL(image.url);
    setImages((current) => current.filter((item) => item.id !== id));
  }

  function selectImages(files: FileList | null) {
    if (!files) return;
    const selected: typeof images = [];
    setImageError("");
    for (const file of Array.from(files)) {
      const issue = validateChatImage(file, images.length + selected.length);
      if (issue) {
        setImageError(issue);
        break;
      }
      selected.push({
        id: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      });
    }
    setImages((current) => [...current, ...selected]);
  }

  async function ask(event?: SyntheticEvent<HTMLFormElement>, preset?: string, explicitFollowUp = false) {
    event?.preventDefault();
    const text = (preset ?? question).trim();
    if (text.length < 5 || busy || inFlight.current) return;
    inFlight.current = true;
    const followUp = !resolved && Boolean(answer && activeIssue && (explicitFollowUp || sameChatConcern(text, activeIssue)));
    const context: ChatContext | undefined = followUp ? { issue: activeIssue, previousAnswers: triedAnswers.slice(-2), unresolved: true } : undefined;
    if (answer && !resolved) setHistory((current) => [...current, answer]);
    setCommonOpen(false);
    setQuestion('');
    setSentMessage(text);
    setBusy(true);
    setError("");
    setResolved(false);
    setVisualOpen(false);
    setAnswer(undefined);
    try {
      const result = await chatAnswer({ text, context, explicitFollowUp, previous: answer, request: api.ask });
      setActiveIssue(context?.issue ?? text);
      setTriedAnswers(resolvableSources.has(result.source) ? [...(context?.previousAnswers ?? []), result.answer.slice(0, 6000)].slice(-2) : context?.previousAnswers ?? []);
      setAnswer(result);
      setSentMessage('');
      if (result.nextAction === 'urgent-ticket') void navigate('/create-ticket', { state: { ...requestDraft(result), initialDescription: problemDescription(context?.issue ?? text, text) } });
    } catch (error_) {
      setError((error_ as Error).message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function markHelpful() {
    if (!answer || !canResolve) return;
    setBusy(true);
    setError("");
    try {
      await api.feedback(answer.question, true, answer.interactionId);
      setResolved(true);
    } catch (error_) {
      setError((error_ as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openRequest() {
    if (!answer) return;
    if (visualEnabled && images.length > 0 && !answer.triage.critical) {
      setVisualOpen(true);
      return;
    }
    openStandardRequest();
  }

  function openStandardRequest() {
    if (!answer) return;
    void navigate("/create-ticket", {
      state: { ...requestDraft({ ...answer, question: activeIssue || answer.question }, demoMode ? [] : images.map((image) => image.file)), initialDescription: problemDescription(activeIssue || answer.question, answer.question) },
    });
  }

  return (
    <div className="chat-page">
      <header className="chat-page-heading">
        <button
          className="icon-button"
          title="Back to Home"
          aria-label="Back to Home"
          onClick={() => void navigate("/home")}
        >
          <ArrowLeft size={21} />
        </button>
        <span className="chat-page-agent">
          <MessageCircle size={23} />
        </span>
        <div>
          <h1>Ask Overdrive</h1>
          <p>BMW customer care</p>
        </div>
        <button
          className="common-issues-toggle"
          aria-expanded={commonOpen}
          aria-controls="chat-common-issues"
          onClick={() => setCommonOpen((current) => !current)}
        >
          <CircleHelp size={17} />
          <span>Common issues</span>
          <ChevronDown size={16} />
        </button>
      </header>
      <div
        className="chat-transcript"
        ref={transcript}
        role="log"
        aria-label="Overdrive conversation"
      >
        {!history.length && !answer && !sentMessage && (
          <div className="chat-greeting">
            <Headphones size={27} />
            <h2>Hello. How can we help?</h2>
            <p>Tell us about your concern, or choose a common issue below.</p>
          </div>
        )}
        {commonOpen && (
          <section
            className="chat-common-issues"
            id="chat-common-issues"
            aria-label="Common issues"
          >
            <label htmlFor="support-topic">
              <span>Choose a support topic</span>
              <select
                id="support-topic"
                value={topic.id}
                disabled={busy}
                onChange={(event) => chooseTopic(event.target.value)}
              >
                {supportTopics.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="chat-suggested-questions">
              <h3>{topic.title}</h3>
              {topic.questions.map((item) => (
                <button
                  key={item}
                  disabled={busy}
                  onClick={() => void ask(undefined, item)}
                >
                  <span>{item}</span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          </section>
        )}
        {history.map((item, index) => (
          <ConversationResult
            key={`${item.question}-${index}`}
            answer={item}
            resolved={false}
            busy={false}
            archived
            onResolved={() => {}}
            onRequest={() => {}}
            onUnresolved={() => {}}
            onClose={() => {}}
          />
        ))}
        {sentMessage && <div className="support-customer-message chat-sent-message"><MessageSquare size={18} /><p>{sentMessage}</p></div>}
        {busy && (
          <output className="support-loading">
            <span className="sr-only">Overdrive is checking guidance</span>
            <span className="chat-typing-dots" aria-hidden="true"><span /><span /><span /></span>
          </output>
        )}
        {error && (
          <div className="alert error" role="alert">
            <div>
              <strong>We couldn't get an answer just now.</strong>
              <p>{error}</p>
            </div>
            <button className="button secondary" onClick={() => void ask(undefined, sentMessage || question)}>
              <RefreshCw size={16} />
              Retry
            </button>
          </div>
        )}
        {answer && visualOpen && (
          <VisualSupport
            question={activeIssue || answer.question}
            initialFiles={demoMode ? [] : images.map((image) => image.file)}
            onCreated={(ticket) => void navigate(`/ticket/${ticket.ticketId}`)}
            onClose={() => void navigate("/home")}
            onFallback={() => {
              setVisualOpen(false);
              openStandardRequest();
            }}
          />
        )}
        {answer && !visualOpen && (
          <ConversationResult
            key={`${answer.question}-${history.length}`}
            answer={answer}
            resolved={resolved}
            busy={busy}
            onResolved={() => void markHelpful()}
            onRequest={openStandardRequest}
            onUnresolved={() => void ask(undefined, "It is still not resolved", true)}
            onAnalyzePhotos={visualEnabled && images.length > 0 && !answer.triage.critical ? openRequest : undefined}
            onClose={() => void navigate("/home")}
          />
        )}
      </div>
      <form className="chat-page-composer" onSubmit={ask}>
        {imageError && (
          <p className="chat-upload-error" role="alert">
            {imageError}
          </p>
        )}
        {images.length > 0 && (
          <div className="chat-image-previews">
            {images.map((image) => (
              <div key={image.id}>
                <img
                  src={image.url}
                  alt={`Selected image: ${image.file.name}`}
                />
                <button
                  type="button"
                  title={`Remove ${image.file.name}`}
                  aria-label={`Remove ${image.file.name}`}
                  disabled={busy}
                  onClick={() => removeImage(image.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="chat-page-input">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            tabIndex={-1}
            aria-label="Choose chat images"
            onChange={(event) => {
              selectImages(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="attach-chat-image"
            aria-label="Attach image"
            title="Attach image"
            disabled={busy || images.length >= 5 || resolved}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={22} />
          </button>
          <label className="sr-only" htmlFor="question">
            Your issue
          </label>
          <textarea
            ref={composer}
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            minLength={5}
            maxLength={400}
            required
            disabled={busy || resolved}
            placeholder="Type your service concern..."
            rows={2}
          />
          <button
            type="submit"
            className="send-chat-issue"
            aria-label="Send issue"
            title="Send issue"
            disabled={busy || resolved || question.trim().length < 5}
          >
            <Send size={21} />
          </button>
        </div>
        <p>
          {demoMode && images.length
            ? "Demo preview only. Images are not uploaded."
            : "Images can be shared with your advisor when a request is confirmed."}{" "}
          Photos are not analyzed by this chat.
        </p>
      </form>
    </div>
  );
}
