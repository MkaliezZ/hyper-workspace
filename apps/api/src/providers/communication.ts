import type { CommunicationMessage, CommunicationRoom } from "@hyper/contracts";
/** Source data stays behind this boundary; callers never receive source credentials. */
export interface CommunicationProvider {
  listRooms(): Promise<CommunicationRoom[]>;
  room(id: string): Promise<CommunicationRoom>;
  messages(
    id: string,
    before?: string,
  ): Promise<{ messages: CommunicationMessage[]; before: string | null }>;
  send(
    id: string,
    content: string,
    referenceId: string,
  ): Promise<CommunicationMessage>;
  find(
    id: string,
    messageId: string,
  ): Promise<CommunicationMessage | undefined>;
}
