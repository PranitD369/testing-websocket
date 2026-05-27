import { nanoid } from 'nanoid';

export const newSessionId = (): string => `s_${nanoid(16)}`;
export const newFrameId = (): string => `f_${nanoid(10)}`;
