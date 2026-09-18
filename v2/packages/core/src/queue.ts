import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { commandSchema, type Command } from './commands.js';

export function localEndpoint(value: string) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('v2 currently supports only a loopback local service endpoint');
  }
  return endpoint.origin;
}

export class LocalQueue {
  readonly client: SQSClient;
  readonly endpoint: string;
  url = '';
  deadLetterUrl = '';

  constructor(endpoint: string) {
    this.endpoint = localEndpoint(endpoint);
    this.client = new SQSClient({
      endpoint: this.endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      maxAttempts: 3,
    });
  }

  private queueUrl(value: string | undefined) {
    if (!value) throw new Error('Local queue service returned no URL');
    const url = new URL(value);
    return `${this.endpoint}${url.pathname}`;
  }

  async initialize(name: string) {
    if (!/^[a-z][a-z0-9-]{0,65}$/.test(name)) throw new Error('Invalid queue name');
    const deadLetter = await this.client.send(
      new CreateQueueCommand({
        QueueName: `${name}-dlq`,
        Attributes: { MessageRetentionPeriod: '1209600' },
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    this.deadLetterUrl = this.queueUrl(deadLetter.QueueUrl);
    const attributes = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.deadLetterUrl,
        AttributeNames: ['QueueArn'],
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error('Local queue service returned no dead-letter ARN');
    const queue = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: {
          VisibilityTimeout: '60',
          ReceiveMessageWaitTimeSeconds: '10',
          MessageRetentionPeriod: '345600',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
        },
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    this.url = this.queueUrl(queue.QueueUrl);
  }

  private ready() {
    if (!this.url) throw new Error('Queue is not initialized');
    return this.url;
  }

  async send(command: Command) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.ready(),
        MessageBody: JSON.stringify(commandSchema.parse(command)),
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
  }

  async receive(signal?: AbortSignal, waitSeconds = 10) {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.ready(),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      {
        abortSignal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
          : AbortSignal.timeout(25_000),
      },
    );
    return result.Messages?.[0];
  }

  async acknowledge(receipt: string) {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.ready(), ReceiptHandle: receipt }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
  }

  async visibility(receipt: string, seconds: number) {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.ready(),
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
  }

  /**
   * Queue-native backlog. Database counters alone cannot see work that was
   * published but never delivered, retried or dead-lettered.
   */
  async depth() {
    const count = async (url: string) => {
      const result = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
        { abortSignal: AbortSignal.timeout(25_000) },
      );
      return {
        ready: Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      };
    };
    const main = await count(this.ready());
    if (!this.deadLetterUrl) throw new Error('Queue is not initialized');
    const dead = await count(this.deadLetterUrl);
    return { ...main, deadLetter: dead.ready + dead.inFlight };
  }

  close() {
    this.client.destroy();
  }

  async receiveDeadLetter() {
    if (!this.deadLetterUrl) throw new Error('Queue is not initialized');
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.deadLetterUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 60,
      }),
      { abortSignal: AbortSignal.timeout(25_000) },
    );
    return result.Messages?.[0];
  }
}
