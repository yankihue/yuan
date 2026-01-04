/**
 * Shared types for calendar integrations
 */

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  calendarId: string;
  provider: 'google' | 'apple';
  attendees?: string[];
  recurrence?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
}

export interface CreateEventParams {
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  calendarId?: string;
  attendees?: string[];
  recurrence?: string;
}

export interface UpdateEventParams {
  eventId: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  start?: Date;
  end?: Date;
  allDay?: boolean;
  attendees?: string[];
}

export interface DeleteEventParams {
  eventId: string;
  calendarId?: string;
}

export interface ListEventsParams {
  calendarId?: string;
  startDate?: Date;
  endDate?: Date;
  maxResults?: number;
}

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface CheckAvailabilityParams {
  start: Date;
  end: Date;
  calendarIds?: string[];
}

export interface FindFreeSlotsParams {
  startDate: Date;
  endDate: Date;
  duration: number; // in minutes
  calendarIds?: string[];
  workingHoursStart?: number; // hour of day (0-23)
  workingHoursEnd?: number; // hour of day (0-23)
}

export interface CalendarInfo {
  id: string;
  name: string;
  provider: 'google' | 'apple';
  primary?: boolean;
  color?: string;
}

export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(params: ListEventsParams): Promise<CalendarEvent[]>;
  createEvent(params: CreateEventParams): Promise<CalendarEvent>;
  updateEvent(params: UpdateEventParams): Promise<CalendarEvent>;
  deleteEvent(params: DeleteEventParams): Promise<void>;
  checkAvailability(params: CheckAvailabilityParams): Promise<boolean>;
  findFreeSlots(params: FindFreeSlotsParams): Promise<TimeSlot[]>;
}
