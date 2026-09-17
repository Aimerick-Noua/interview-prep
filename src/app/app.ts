import { ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { finalize } from 'rxjs';
import { marked } from 'marked';
import { LEVELS, Level, Question } from './data/questions.data';
import { ANGULAR_LEVELS } from './data/questions-angular.data';

interface CachedAnswer {
  kid: string;
  engineer: string;
  generatedAt: string;
}

type Tab = 'java' | 'angular';
type SpeechSection = 'kid' | 'engineer' | null;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {

  // ---- Tabs ----
  tabs: { id: Tab; label: string }[] = [
    { id: 'java', label: 'Java' },
    { id: 'angular', label: 'Angular' },
  ];
  activeTab: Tab = 'java';

  private levelsByTab: Record<Tab, Level[]> = {
    java: LEVELS,
    angular: ANGULAR_LEVELS,
  };

  private selectedLevelByTab: Record<Tab, Level | null> = {
    java: null,
    angular: null,
  };

  private selectedQuestionByTab: Record<Tab, Question | null> = {
    java: null,
    angular: null,
  };

  private searchTermByTab: Record<Tab, string> = {
    java: '',
    angular: '',
  };

  groqApiKey = '';
  isLoading = false;
  currentAnswer: CachedAnswer | null = null;
  showApiKeyModal = false;
  tempApiKey = '';
  errorMessage = '';
  includeKidVersion = false;

  // ---- Speech (Text-to-Speech) ----
  private synth = window.speechSynthesis;
  speakingSection: SpeechSection = null;

  availableVoices: SpeechSynthesisVoice[] = [];
  selectedVoiceURI: string = '';
  showVoiceModal = false;

  speechRate: number = 1;

  // ---- Swipe handling ----
  private touchStartX = 0;
  private touchStartY = 0;
  private readonly swipeThreshold = 60;

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    private sanitizer: DomSanitizer
  ) {
    // Configure marked once
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

  ngOnInit() {
    this.groqApiKey = localStorage.getItem('groqApiKey') || '';
    this.selectedVoiceURI = localStorage.getItem('ttsVoiceURI') || '';
    this.speechRate = parseFloat(localStorage.getItem('ttsRate') || '1');

    this.loadVoices();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = () => this.loadVoices();
    }

    if (this.levels.length) {
      this.selectLevel(this.levels[0]);
    }
  }

  ngOnDestroy() {
    this.stopSpeech();
  }

  // ---- Tab-aware getters/setters (template stays mostly untouched) ----

  get levels(): Level[] {
    return this.levelsByTab[this.activeTab];
  }

  get selectedLevel(): Level | null {
    return this.selectedLevelByTab[this.activeTab];
  }
  set selectedLevel(level: Level | null) {
    this.selectedLevelByTab[this.activeTab] = level;
  }

  get selectedQuestion(): Question | null {
    return this.selectedQuestionByTab[this.activeTab];
  }
  set selectedQuestion(question: Question | null) {
    this.selectedQuestionByTab[this.activeTab] = question;
  }

  get searchTerm(): string {
    return this.searchTermByTab[this.activeTab];
  }
  set searchTerm(value: string) {
    this.searchTermByTab[this.activeTab] = value;
  }

  get filteredQuestions(): Question[] {
    if (!this.selectedLevel) return [];
    const term = this.searchTerm.toLowerCase().trim();
    if (!term) return this.selectedLevel.questions;
    return this.selectedLevel.questions.filter(q =>
      q.question.toLowerCase().includes(term)
    );
  }

  // ---- Tab switching ----

  selectTab(tab: Tab) {
    if (tab === this.activeTab) return;
    this.switchTo(tab);
  }

  private switchTo(tab: Tab) {
    this.stopSpeech();
    this.activeTab = tab;
    this.errorMessage = '';

    // Lazily select the first level of a tab the first time it's visited.
    if (!this.selectedLevel && this.levels.length) {
      this.selectLevel(this.levels[0]);
    } else if (this.selectedQuestion) {
      this.loadCachedAnswer(this.selectedQuestion.id);
    } else {
      this.currentAnswer = null;
    }
  }

  // Swipe left/right on the main content area to switch tabs.
  onTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
  }

  onTouchEnd(event: TouchEvent) {
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - this.touchStartX;
    const deltaY = touch.clientY - this.touchStartY;

    // Ignore mostly-vertical gestures (scrolling).
    if (Math.abs(deltaX) < this.swipeThreshold || Math.abs(deltaX) < Math.abs(deltaY)) {
      return;
    }

    const currentIndex = this.tabs.findIndex(t => t.id === this.activeTab);

    if (deltaX < 0) {
      // Swiped left -> go to next tab
      const next = this.tabs[currentIndex + 1];
      if (next) this.switchTo(next.id);
    } else {
      // Swiped right -> go to previous tab
      const prev = this.tabs[currentIndex - 1];
      if (prev) this.switchTo(prev.id);
    }
  }

  // ---- Existing behavior, now tab-aware ----

  selectLevel(level: Level) {
    this.stopSpeech();
    this.selectedLevel = level;
    this.selectedQuestion = null;
    this.currentAnswer = null;
    this.errorMessage = '';
  }

  selectQuestion(q: Question) {
    this.stopSpeech();
    this.selectedQuestion = q;
    this.errorMessage = '';
    this.loadCachedAnswer(q.id);
  }

  private cacheKey(id: number): string {
    return `${this.activeTab}_answer_${id}`;
  }

  loadCachedAnswer(id: number) {
    const raw = localStorage.getItem(this.cacheKey(id));
    this.currentAnswer = raw ? JSON.parse(raw) : null;
  }

  saveAnswer(id: number, answer: CachedAnswer) {
    localStorage.setItem(this.cacheKey(id), JSON.stringify(answer));
    this.currentAnswer = answer;
  }

  clearAnswer() {
    this.stopSpeech();
    if (!this.selectedQuestion) return;
    localStorage.removeItem(this.cacheKey(this.selectedQuestion.id));
    this.currentAnswer = null;
  }

  openApiKeyModal() {
    this.tempApiKey = this.groqApiKey;
    this.showApiKeyModal = true;
  }

  saveApiKey() {
    this.groqApiKey = this.tempApiKey.trim();
    localStorage.setItem('groqApiKey', this.groqApiKey);
    this.showApiKeyModal = false;
  }

generateAnswer(regenerate = false): void {
  if (!this.selectedQuestion) return;

  if (!this.groqApiKey) {
    this.openApiKeyModal();
    return;
  }

  if (this.currentAnswer && !regenerate) return;

  this.stopSpeech();
  this.isLoading = true;
  this.errorMessage = '';
  this.currentAnswer = null;
  this.cdr.detectChanges();

  const topic = this.activeTab === 'angular' ? 'Angular' : 'Java';
  const question = this.selectedQuestion.question;

  const prompt = `
You are a senior ${topic} engineer, software architect, and technical interviewer
with 15+ years of production experience.

Your job is to teach the concept deeply enough that I can:
1. Understand what it actually means.
2. Explain it confidently in a technical interview.
3. Understand what happens internally.
4. Know when and why to use it in production.
5. Discuss trade-offs and answer senior-level follow-up questions.

Do NOT give me a shallow textbook definition.
Focus on engineering reasoning, production behavior, and interview usefulness.

QUESTION:
${question}

${this.includeKidVersion ? `
## 🧒 Explain like I'm 12

Explain the core idea using a simple real-world analogy.

Rules:
- Keep it short and intuitive.
- Avoid unnecessary technical terminology.
- If you use a technical term, explain it briefly.
- The goal is to make the concept easy to visualize.
` : ''}

## 🛠️ Software Engineer / Interview Answer

### 1. What is it?

Give a precise definition.

Explain:
- What the concept, feature, API, pattern, or mechanism actually is.
- What problem category it belongs to.
- Clearly distinguish between a language feature, JDK/API feature, JVM behavior, framework behavior, or architectural concept when relevant.

Do not start with vague textbook wording.

### 2. Why does it exist?

Explain the engineering problem that led to this concept.

Answer:
- What problem does it solve?
- What would be difficult, unsafe, slow, repetitive, or impossible without it?
- What problem does it prevent or simplify?
- Why would an engineer choose it instead of a simpler alternative?

Focus on the motivation, not just the definition.

### 3. How does it work internally?

Explain the important mechanics behind it.

Depending on the topic, discuss the relevant internal behavior such as:
- JVM behavior
- memory
- stack/heap/metaspace
- object lifecycle
- bytecode only when genuinely useful
- collections internals
- hashing
- concurrency
- threads
- locks
- atomicity
- visibility
- ordering
- happens-before
- synchronization
- garbage collection
- CPU/cache implications
- Spring container behavior
- dependency injection
- proxies
- transactions
- HTTP/network behavior
- Angular change detection
- RxJS
- signals
- rendering
- browser behavior

Do NOT dump implementation details just to sound advanced.

Clearly distinguish:
- guaranteed language/API behavior
- framework behavior
- JVM implementation details
- implementation details that may vary by version

### 4. When would I use it?

Give realistic production situations.

Include:
- When it is appropriate.
- When it is NOT appropriate.
- A realistic enterprise example.
- If there is a common alternative, explain when you would choose that alternative instead.

Prefer examples involving:
- backend services
- REST APIs
- microservices
- databases
- distributed systems
- concurrent applications
- financial systems
- cloud applications
- enterprise Angular applications

Use concrete engineering reasoning rather than generic examples.

### 5. What are the trade-offs?

Discuss the important engineering trade-offs.

Include relevant points such as:
- performance
- memory
- CPU
- concurrency
- scalability
- complexity
- maintainability
- debugging
- reliability
- security
- consistency
- operational cost
- developer productivity

Do not invent performance numbers or benchmarks.

If there is no meaningful trade-off for a particular point, do not force one.

## Production Example

Give ONE realistic production scenario showing how this concept would appear in a real system.

Explain:
- the problem
- the design decision
- why this concept is useful
- one important trade-off

Keep it practical rather than theoretical.

## Code Example

Provide ONE clean, realistic code example when code makes sense.

Requirements:
- Prefer modern ${topic} practices.
- Keep the example small enough to explain during an interview.
- Use meaningful names.
- Explain the important lines.
- Avoid unnecessary boilerplate.
- Do not use deprecated APIs unless the question specifically concerns them.

If code is not appropriate for the concept, explain the concept without forcing code.

## Common Interview Traps

Give 3-5 mistakes candidates commonly make.

For each trap:
- state the incorrect assumption
- explain the correct understanding

Prioritize traps that distinguish a strong engineer from someone who memorized definitions.

## Senior Follow-Up Questions

Give 4-6 likely follow-up questions an experienced interviewer could ask.

These should progressively become harder.

Include questions involving:
- internals
- edge cases
- concurrency where relevant
- performance where relevant
- production design
- trade-offs

Do NOT answer all of them unless a very short answer is necessary for context.

## Interview Memory

Finish with 3-5 concise points I should remember when answering this question in an interview.

These should be memorable principles, not a generic summary.

GENERAL RULES:

- Be technically accurate.
- Prefer depth over buzzwords.
- Explain WHY, not only WHAT.
- Use production-oriented reasoning.
- Do not fabricate behavior, benchmarks, or metrics.
- Do not invent APIs or framework behavior.
- If behavior is version-dependent, say so.
- If something is an implementation detail rather than a guarantee, explicitly say so.
- Use concise paragraphs and bullets.
- Avoid giant tables.
- Avoid unnecessary bytecode or source-code dumps.
- Do not repeat the same explanation in multiple sections.
- Assume I already know basic programming syntax.
- Explain advanced concepts clearly without talking down to an experienced developer.
- The answer should sound like something a strong senior engineer could actually say in an interview.
- For complex topics, use enough detail to properly explain the concept. Do not impose an artificial short word limit.
- For simple topics, stay concise.

IMPORTANT FOR JAVA QUESTIONS:

When relevant, distinguish clearly between:

Java language feature
→ JDK/API behavior
→ JVM behavior
→ operating-system behavior

For concurrency questions, explicitly reason about:
atomicity, visibility, ordering, happens-before, race conditions, thread safety, contention, deadlock, starvation, and livelock when applicable.

For collection questions, explain the relevant data structure and complexity when useful.

For JVM questions, explain the runtime behavior rather than only naming components.

IMPORTANT FOR ANGULAR QUESTIONS:

When relevant, distinguish between:
Angular framework behavior
→ TypeScript behavior
→ JavaScript runtime behavior
→ browser behavior

Discuss change detection, signals, RxJS, dependency injection, rendering, lifecycle, and performance only when relevant.

Do not force concepts that are unrelated to the question.

The final answer must preserve the exact section headings above because the application parses the response using these headings.
`;

  const body = {
    model: 'openai/gpt-oss-120b',
    messages: [
      {
        role: 'system',
        content: `
You are a senior ${topic} engineer, software architect, and technical interviewer.

Teach production-grade engineering, not memorized textbook definitions.

Your answers must help the candidate:
- understand the concept deeply
- explain it clearly in an interview
- reason about internals
- make production decisions
- discuss trade-offs
- handle senior-level follow-up questions

Always preserve the exact Markdown headings requested by the user.
Do not rename, remove, or reorder the requested headings.
`
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.45,
    max_tokens: 4000
  };

  const headers = new HttpHeaders({
    Authorization: `Bearer ${this.groqApiKey}`,
    'Content-Type': 'application/json'
  });

  this.http
    .post<unknown>(
      'https://api.groq.com/openai/v1/chat/completions',
      body,
      { headers }
    )
    .pipe(
      finalize(() => {
        this.isLoading = false;
        this.cdr.detectChanges();
      })
    )
    .subscribe({
      next: (res) => {
        try {
          const response = res as {
            choices?: Array<{
              message?: {
                content?: string;
              };
            }>;
          };

          const content =
            response.choices?.[0]?.message?.content?.trim() ?? '';

          if (!content) {
            this.errorMessage = 'The model returned an empty answer.';
            return;
          }

          let kid = '';
          let engineer = '';

          const engineerMarker =
            '## 🛠️ Software Engineer / Interview Answer';

          const kidMarker =
            "## 🧒 Explain like I'm 12";

          if (this.includeKidVersion) {
            const engineerIndex = content.indexOf(engineerMarker);

            if (engineerIndex >= 0) {
              const kidContent = content
                .substring(0, engineerIndex)
                .replace(kidMarker, '')
                .trim();

              const engineerContent = content
                .substring(
                  engineerIndex + engineerMarker.length
                )
                .trim();

              kid = kidContent;
              engineer = engineerContent;
            } else {
              // Fallback if the model did not follow the heading format.
              engineer = content;
            }
          } else {
            engineer = content
              .replace(
                /^## 🛠️ Software Engineer\s*\/\s*Interview Answer/im,
                ''
              )
              .trim();
          }

          const answer: CachedAnswer = {
            kid,
            engineer: engineer || content,
            generatedAt: new Date().toISOString()
          };

          this.saveAnswer(this.selectedQuestion!.id, answer);
          this.cdr.detectChanges();
        } catch (err: unknown) {
          const message =
            err instanceof Error
              ? err.message
              : 'Unknown error';

          this.errorMessage =
            `Error while processing the answer: ${message}`;
        }
      },

      error: (err: unknown) => {
        const error = err as {
          error?: {
            error?: {
              message?: string;
            };
          };
          message?: string;
        };

        this.errorMessage =
          error?.error?.error?.message ||
          error?.message ||
          'Request failed.';
      }
    });
}

  renderMarkdown(text: string): SafeHtml {
    if (!text) return '';
    const html = marked.parse(text) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  // ---- Text-to-Speech ----

  private loadVoices() {
    const voices = this.synth.getVoices();
    if (!voices.length) return;

    // English voices first (most relevant here), rest after
    this.availableVoices = [...voices].sort((a, b) => {
      const aEn = a.lang.startsWith('en') ? 0 : 1;
      const bEn = b.lang.startsWith('en') ? 0 : 1;
      if (aEn !== bEn) return aEn - bEn;
      return a.name.localeCompare(b.name);
    });

    // Pick a sane default the first time, if nothing saved yet
    if (!this.selectedVoiceURI) {
      const defaultVoice =
        this.availableVoices.find(v => v.lang.startsWith('en') && /Google|Natural|Online/i.test(v.name)) ||
        this.availableVoices.find(v => v.lang.startsWith('en')) ||
        this.availableVoices[0];
      if (defaultVoice) this.selectedVoiceURI = defaultVoice.voiceURI;
    }

    this.cdr.detectChanges();
  }

  get selectedVoice(): SpeechSynthesisVoice | undefined {
    return this.availableVoices.find(v => v.voiceURI === this.selectedVoiceURI);
  }

  openVoiceModal() {
    this.loadVoices();
    this.showVoiceModal = true;
  }

  selectVoice(voice: SpeechSynthesisVoice) {
    this.selectedVoiceURI = voice.voiceURI;
    localStorage.setItem('ttsVoiceURI', voice.voiceURI);
  }

  previewVoice(voice: SpeechSynthesisVoice, event: Event) {
    event.stopPropagation();
    this.synth.cancel();
    const utterance = new SpeechSynthesisUtterance('Hi, this is a preview of my voice.');
    utterance.voice = voice;
    utterance.rate = this.speechRate;
    this.synth.speak(utterance);
  }

  setSpeechRate(rate: number | string) {
    this.speechRate = parseFloat(rate as string);
    localStorage.setItem('ttsRate', this.speechRate.toString());

    // If something is playing right now, restart it at the new rate
    // (speechSynthesis doesn't support changing rate mid-utterance).
    if (this.speakingSection && this.currentAnswer) {
      const text = this.speakingSection === 'kid' ? this.currentAnswer.kid : this.currentAnswer.engineer;
      const section = this.speakingSection;
      this.synth.cancel();
      this.speakingSection = null;
      // tiny delay so the cancel fully clears before restarting
      setTimeout(() => this.toggleSpeech(text, section), 50);
    }
  }

  resetSpeechRate() {
    this.setSpeechRate(1);
  }

  toggleSpeech(text: string, section: 'kid' | 'engineer') {
    if (!text) return;

    // Clicking the same section again -> stop.
    if (this.speakingSection === section) {
      this.stopSpeech();
      return;
    }

    // Switching sections -> cancel whatever was playing first.
    this.synth.cancel();

    const utterance = new SpeechSynthesisUtterance(this.stripMarkdown(text));
    utterance.rate = this.speechRate;
    utterance.pitch = 1;

    if (this.selectedVoice) {
      utterance.voice = this.selectedVoice;
    }

    utterance.onend = () => {
      this.speakingSection = null;
      this.cdr.detectChanges();
    };
    utterance.onerror = () => {
      this.speakingSection = null;
      this.cdr.detectChanges();
    };

    this.speakingSection = section;
    this.synth.speak(utterance);
  }

  private stopSpeech() {
    if (this.synth.speaking || this.synth.pending) {
      this.synth.cancel();
    }
    this.speakingSection = null;
  }

  private stripMarkdown(md: string): string {
    return md
      .replace(/```[\s\S]*?```/g, ' Code example omitted. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();
  }
}