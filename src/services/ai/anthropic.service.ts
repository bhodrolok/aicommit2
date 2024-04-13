import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { ReactiveListChoice } from 'inquirer-reactive-list-prompt';
import { Observable, catchError, concatMap, from, map, of, scan, tap } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';

import { AIService, AIServiceError, AIServiceParams } from './ai.service.js';
import { KnownError } from '../../utils/error.js';
import { deduplicateMessages } from '../../utils/openai.js';
import { DONE, UNDONE, toObservable } from '../../utils/utils.js';

export interface AnthropicServiceError extends AIServiceError {
    error?: {
        error?: {
            message?: string;
        };
    };
}

export class AnthropicService extends AIService {
    private anthropic: Anthropic;

    constructor(private readonly params: AIServiceParams) {
        super(params);
        this.colors = {
            primary: '#AE5630',
            secondary: '#fff',
        };
        this.serviceName = chalk.bgHex(this.colors.primary).hex(this.colors.secondary).bold('[Anthropic]');
        this.errorPrefix = chalk.red.bold(`[Anthropic]`);
        this.anthropic = new Anthropic({ apiKey: this.params.config.ANTHROPIC_KEY });
    }

    generateCommitMessage$(): Observable<ReactiveListChoice> {
        // if (isStream)
        // return this.generateStreamCommitMessage$();
        //

        return fromPromise(this.generateMessage()).pipe(
            concatMap(messages => from(messages)),
            map(message => ({
                name: `${this.serviceName} ${message}`,
                value: message,
                isError: false,
            })),
            catchError(this.handleError$)
        );
    }

    private async generateMessage(): Promise<string[]> {
        try {
            const diff = this.params.stagedDiff.diff;
            const { locale, generate, type, prompt: userPrompt } = this.params.config;
            const maxLength = this.params.config['max-length'];
            const prompt = this.buildPrompt(locale, diff, generate, maxLength, type, userPrompt);

            const result = await this.anthropic.completions.create({
                model: this.params.config.ANTHROPIC_MODEL,
                max_tokens_to_sample: this.params.config['max-tokens'],
                temperature: this.params.config.temperature,
                prompt: `${Anthropic.HUMAN_PROMPT} ${prompt}${Anthropic.AI_PROMPT}`,
            });
            const completion = result.completion;
            return deduplicateMessages(this.sanitizeMessage(completion, this.params.config.type, generate));
        } catch (error) {
            const errorAsAny = error as any;
            if (errorAsAny.code === 'ENOTFOUND') {
                throw new KnownError(`Error connecting to ${errorAsAny.hostname} (${errorAsAny.syscall})`);
            }
            throw errorAsAny;
        }
    }

    handleError$ = (anthropicError: AnthropicServiceError) => {
        const simpleMessage =
            anthropicError.error?.error?.message?.replace(/(\r\n|\n|\r)/gm, '') || 'An error occurred';
        return of({
            name: `${this.errorPrefix} ${simpleMessage}`,
            value: simpleMessage,
            isError: true,
            disabled: true,
        });
    };

    generateStreamCommitMessage$(): Observable<ReactiveListChoice> {
        return this.generateStreamChoice$().pipe(
            scan((acc: ReactiveListChoice[], data: ReactiveListChoice) => {
                const isDone = data.description === DONE;
                if (isDone) {
                    const messages = deduplicateMessages(
                        this.sanitizeMessage(data.value, this.params.config.type, this.params.config.generate)
                    );
                    const isFailedExtract = !messages || messages.length === 0;
                    if (isFailedExtract) {
                        return [
                            {
                                id: `${this.params.keyName}_${DONE}_0`,
                                name: `${this.serviceName} Failed to extract messages from response`,
                                value: `Failed to extract messages from response`,
                                isError: true,
                                description: DONE,
                                disabled: true,
                            },
                        ];
                    }
                    return messages.map((message, index) => {
                        return {
                            id: `${this.params.keyName}_${DONE}_${index}`,
                            name: `${this.serviceName} ${message}`,
                            value: `${message}`,
                            isError: false,
                            description: DONE,
                            disabled: false,
                        };
                    });
                }
                // if has origin data
                const originData = acc.find((origin: ReactiveListChoice) => origin.id === data.id);
                if (originData) {
                    return [...acc.map((origin: ReactiveListChoice) => (data.id === origin.id ? data : origin))];
                }
                // init
                return [{ ...data }];
            }, []),
            concatMap(messages => messages), // flat messages
            catchError(this.handleError$)
        );
    }

    generateStreamChoice$ = (): Observable<ReactiveListChoice> => {
        const diff = this.params.stagedDiff.diff;
        const { locale, generate, type, prompt: userPrompt } = this.params.config;
        const maxLength = this.params.config['max-length'];
        const prompt = this.buildPrompt(locale, diff, generate, maxLength, type, userPrompt);

        const anthropicStream: Promise<AsyncGenerator<Anthropic.Completion>> = this.anthropic.completions.create({
            model: this.params.config.ANTHROPIC_MODEL,
            max_tokens_to_sample: this.params.config['max-tokens'],
            temperature: this.params.config.temperature,
            prompt: `${Anthropic.HUMAN_PROMPT} ${prompt}${Anthropic.AI_PROMPT}`,
            stream: true,
        }) as any as Promise<AsyncGenerator<Anthropic.Completion>>;

        let allValue = '';
        return from(toObservable(anthropicStream)).pipe(
            tap((completion: Anthropic.Completion) => (allValue += completion.completion)),
            map((completion: Anthropic.Completion) => {
                const isDone = !!completion.stop_reason && completion.stop_reason === `stop_sequence`;
                return {
                    id: this.params.keyName,
                    name: `${this.serviceName} ${allValue}`,
                    value: `${allValue}`,
                    isError: false,
                    description: isDone ? DONE : UNDONE,
                    disabled: !isDone,
                };
            })
        );
    };
}
