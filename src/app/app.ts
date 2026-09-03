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

  generateAnswer(regenerate = false) {
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
    let prompt = '';

    if (this.includeKidVersion) {
      prompt = `You are a senior ${topic} interviewer.

Answer the question below in **exactly two short sections**.

## 🧒 Explain like I'm 12
- Maximum 8-10 short sentences or a small table.
- Use simple analogies only.
- No jargon without a quick explanation.

## 🛠️ Software Engineer / Interview Answer
- Be concise and high-signal.
- Structure:
  1. Precise technical explanation (1 short paragraph)
  2. Key points (bullet list, max 5-6 bullets)
  3. One short code example (if useful)
  4. 2-3 common pitfalls (if any)

Do NOT write long tables, long bottom-line summaries, or disassembled bytecode unless absolutely necessary.
Keep the whole answer under 450 words.

Question: ${this.selectedQuestion.question}`;
    } else {
      prompt = `You are a senior ${topic} interviewer.

Answer the question below in a concise, high-signal way.

## 🛠️ Software Engineer / Interview Answer
- Precise technical explanation (1 short paragraph)
- Key points (bullet list, max 5-6 bullets)
- One short code example (if useful)
- 2-3 common pitfalls (if any)

Do NOT write long tables, long bottom-line summaries, or disassembled bytecode.
Keep the whole answer under 350 words.

Question: ${this.selectedQuestion.question}`;
    }

    const body = {
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: `You are a senior ${topic} teacher. Always use the exact ## headings requested when multiple sections are asked.`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.55,
      max_tokens: 2500
    };

    const headers = new HttpHeaders({
      'Authorization': `Bearer ${this.groqApiKey}`,
      'Content-Type': 'application/json'
    });

    this.http
      .post<any>('https://api.groq.com/openai/v1/chat/completions', body, { headers })
      .pipe(
        finalize(() => {
          this.isLoading = false;
          this.cdr.detectChanges();
        })
      )
      .subscribe({
        next: (res) => {
          try {
            const content: string = res?.choices?.[0]?.message?.content ?? '';

            let kid = '';
            let engineer = '';

            if (this.includeKidVersion) {
              const engineerMarker = '## 🛠️ Software Engineer / Interview Answer';
              const kidMarker = '## 🧒 Explain like I\'m 12';

              if (content.includes(engineerMarker)) {
                const parts = content.split(engineerMarker);
                kid = parts[0]
                  .replace(kidMarker, '')
                  .replace(/^[\s#]*🧒?\s*Explain like I['’]m 12/i, '')
                  .trim();
                engineer = (parts[1] || '').trim();
              } else {
                engineer = content;
                kid = '';
              }
            } else {
              // Only engineer version
              engineer = content
                .replace(/## 🛠️ Software Engineer \/ Interview Answer/i, '')
                .trim();
              kid = '';
            }

            const answer: CachedAnswer = {
              kid: kid,
              engineer: engineer || content,
              generatedAt: new Date().toISOString()
            };

            this.saveAnswer(this.selectedQuestion!.id, answer);
            this.cdr.detectChanges();
          } catch (err: any) {
            this.errorMessage = 'Error while processing the answer: ' + err.message;
          }
        },
        error: (err) => {
          this.errorMessage =
            err?.error?.error?.message ||
            err?.message ||
            'Request failed';
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