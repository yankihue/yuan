/**
 * MCP Tools for calendar operations
 */

import { z } from 'zod';
import {
  CalendarProvider,
  CalendarEvent,
  TimeSlot,
  CalendarInfo,
} from './types.js';

// Tool input schemas
export const ListEventsSchema = z.object({
  calendarId: z.string().optional().describe('Calendar ID to list events from. If not specified, uses the primary calendar.'),
  startDate: z.string().optional().describe('Start date for event listing (ISO 8601 format). Defaults to now.'),
  endDate: z.string().optional().describe('End date for event listing (ISO 8601 format). Defaults to 30 days from now.'),
  maxResults: z.number().optional().describe('Maximum number of events to return. Defaults to 250.'),
  provider: z.enum(['google', 'apple', 'all']).optional().describe('Calendar provider to query. Defaults to "all".'),
});

export const CreateEventSchema = z.object({
  title: z.string().describe('Event title/summary'),
  description: z.string().optional().describe('Event description'),
  location: z.string().optional().describe('Event location'),
  start: z.string().describe('Event start time (ISO 8601 format)'),
  end: z.string().describe('Event end time (ISO 8601 format)'),
  allDay: z.boolean().optional().describe('Whether this is an all-day event'),
  calendarId: z.string().optional().describe('Calendar ID to create event in. Defaults to primary.'),
  attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
  recurrence: z.string().optional().describe('Recurrence rule (RRULE format, e.g., "RRULE:FREQ=WEEKLY;COUNT=10")'),
  provider: z.enum(['google']).optional().describe('Calendar provider. Currently only Google supports creating events.'),
});

export const UpdateEventSchema = z.object({
  eventId: z.string().describe('Event ID to update'),
  calendarId: z.string().optional().describe('Calendar ID containing the event. Defaults to primary.'),
  title: z.string().optional().describe('New event title'),
  description: z.string().optional().describe('New event description'),
  location: z.string().optional().describe('New event location'),
  start: z.string().optional().describe('New event start time (ISO 8601 format)'),
  end: z.string().optional().describe('New event end time (ISO 8601 format)'),
  allDay: z.boolean().optional().describe('Whether this is an all-day event'),
  attendees: z.array(z.string()).optional().describe('New list of attendee email addresses'),
  provider: z.enum(['google']).optional().describe('Calendar provider. Currently only Google supports updating events.'),
});

export const DeleteEventSchema = z.object({
  eventId: z.string().describe('Event ID to delete'),
  calendarId: z.string().optional().describe('Calendar ID containing the event. Defaults to primary.'),
  provider: z.enum(['google']).optional().describe('Calendar provider. Currently only Google supports deleting events.'),
});

export const CheckAvailabilitySchema = z.object({
  start: z.string().describe('Start time to check (ISO 8601 format)'),
  end: z.string().describe('End time to check (ISO 8601 format)'),
  calendarIds: z.array(z.string()).optional().describe('Calendar IDs to check. Defaults to primary calendar.'),
  provider: z.enum(['google', 'apple', 'all']).optional().describe('Calendar provider to query. Defaults to "all".'),
});

export const FindFreeSlotsSchema = z.object({
  startDate: z.string().describe('Start date for searching (ISO 8601 format)'),
  endDate: z.string().describe('End date for searching (ISO 8601 format)'),
  duration: z.number().describe('Required slot duration in minutes'),
  calendarIds: z.array(z.string()).optional().describe('Calendar IDs to check. Defaults to primary calendar.'),
  workingHoursStart: z.number().optional().describe('Start of working hours (0-23). Defaults to 9.'),
  workingHoursEnd: z.number().optional().describe('End of working hours (0-23). Defaults to 17.'),
  provider: z.enum(['google', 'apple', 'all']).optional().describe('Calendar provider to query. Defaults to "all".'),
});

export const ListCalendarsSchema = z.object({
  provider: z.enum(['google', 'apple', 'all']).optional().describe('Calendar provider to query. Defaults to "all".'),
});

export type ListEventsInput = z.infer<typeof ListEventsSchema>;
export type CreateEventInput = z.infer<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type DeleteEventInput = z.infer<typeof DeleteEventSchema>;
export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilitySchema>;
export type FindFreeSlotsInput = z.infer<typeof FindFreeSlotsSchema>;
export type ListCalendarsInput = z.infer<typeof ListCalendarsSchema>;

// Tool handlers
export class CalendarTools {
  private googleClient: CalendarProvider | null;
  private appleClient: CalendarProvider | null;

  constructor(
    googleClient: CalendarProvider | null,
    appleClient: CalendarProvider | null
  ) {
    this.googleClient = googleClient;
    this.appleClient = appleClient;
  }

  private getClients(provider?: 'google' | 'apple' | 'all'): CalendarProvider[] {
    const clients: CalendarProvider[] = [];

    if (provider === 'google' || provider === 'all' || !provider) {
      if (this.googleClient) clients.push(this.googleClient);
    }

    if (provider === 'apple' || provider === 'all' || !provider) {
      if (this.appleClient) clients.push(this.appleClient);
    }

    return clients;
  }

  async listCalendars(input: ListCalendarsInput): Promise<CalendarInfo[]> {
    const clients = this.getClients(input.provider);
    const allCalendars: CalendarInfo[] = [];

    for (const client of clients) {
      const calendars = await client.listCalendars();
      allCalendars.push(...calendars);
    }

    return allCalendars;
  }

  async listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
    const clients = this.getClients(input.provider);
    const allEvents: CalendarEvent[] = [];

    for (const client of clients) {
      const events = await client.listEvents({
        calendarId: input.calendarId,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
        maxResults: input.maxResults,
      });
      allEvents.push(...events);
    }

    // Sort by start time
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Apply max results limit across all providers
    if (input.maxResults && allEvents.length > input.maxResults) {
      return allEvents.slice(0, input.maxResults);
    }

    return allEvents;
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEvent> {
    if (!this.googleClient) {
      throw new Error('Google Calendar client not configured. Only Google Calendar supports creating events.');
    }

    return this.googleClient.createEvent({
      title: input.title,
      description: input.description,
      location: input.location,
      start: new Date(input.start),
      end: new Date(input.end),
      allDay: input.allDay,
      calendarId: input.calendarId,
      attendees: input.attendees,
      recurrence: input.recurrence,
    });
  }

  async updateEvent(input: UpdateEventInput): Promise<CalendarEvent> {
    if (!this.googleClient) {
      throw new Error('Google Calendar client not configured. Only Google Calendar supports updating events.');
    }

    return this.googleClient.updateEvent({
      eventId: input.eventId,
      calendarId: input.calendarId,
      title: input.title,
      description: input.description,
      location: input.location,
      start: input.start ? new Date(input.start) : undefined,
      end: input.end ? new Date(input.end) : undefined,
      allDay: input.allDay,
      attendees: input.attendees,
    });
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    if (!this.googleClient) {
      throw new Error('Google Calendar client not configured. Only Google Calendar supports deleting events.');
    }

    await this.googleClient.deleteEvent({
      eventId: input.eventId,
      calendarId: input.calendarId,
    });
  }

  async checkAvailability(input: CheckAvailabilityInput): Promise<boolean> {
    const clients = this.getClients(input.provider);
    const start = new Date(input.start);
    const end = new Date(input.end);

    for (const client of clients) {
      const isAvailable = await client.checkAvailability({
        start,
        end,
        calendarIds: input.calendarIds,
      });

      if (!isAvailable) {
        return false;
      }
    }

    return true;
  }

  async findFreeSlots(input: FindFreeSlotsInput): Promise<TimeSlot[]> {
    const clients = this.getClients(input.provider);

    if (clients.length === 0) {
      throw new Error('No calendar providers configured');
    }

    // If only one client, use its findFreeSlots directly
    if (clients.length === 1) {
      return clients[0].findFreeSlots({
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        duration: input.duration,
        calendarIds: input.calendarIds,
        workingHoursStart: input.workingHoursStart,
        workingHoursEnd: input.workingHoursEnd,
      });
    }

    // For multiple clients, we need to find slots that are free in ALL calendars
    // First, collect all events from all providers
    const allEvents: CalendarEvent[] = [];
    for (const client of clients) {
      const events = await client.listEvents({
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
      });
      allEvents.push(...events);
    }

    // Sort events by start time
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Find free slots
    const workingHoursStart = input.workingHoursStart ?? 9;
    const workingHoursEnd = input.workingHoursEnd ?? 17;
    const durationMs = input.duration * 60 * 1000;

    const freeSlots: TimeSlot[] = [];
    const currentDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);

    while (currentDate < endDate) {
      const dayStart = new Date(currentDate);
      dayStart.setHours(workingHoursStart, 0, 0, 0);

      const dayEnd = new Date(currentDate);
      dayEnd.setHours(workingHoursEnd, 0, 0, 0);

      const effectiveStart = dayStart > new Date() ? dayStart : new Date();

      if (effectiveStart < dayEnd) {
        let slotStart = effectiveStart;

        while (slotStart.getTime() + durationMs <= dayEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          const hasConflict = allEvents.some(
            (event) => slotStart < event.end && slotEnd > event.start
          );

          if (!hasConflict) {
            freeSlots.push({
              start: new Date(slotStart),
              end: slotEnd,
            });
            slotStart = slotEnd;
          } else {
            const conflictingEvent = allEvents.find(
              (event) => slotStart < event.end && slotEnd > event.start
            );
            if (conflictingEvent) {
              slotStart = new Date(conflictingEvent.end);
            } else {
              slotStart = new Date(slotStart.getTime() + 15 * 60 * 1000);
            }
          }
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
      currentDate.setHours(0, 0, 0, 0);
    }

    return freeSlots;
  }
}

// Format helpers for MCP responses
export function formatEvent(event: CalendarEvent): string {
  const lines = [
    `ID: ${event.id}`,
    `Title: ${event.title}`,
    `Start: ${event.start.toISOString()}`,
    `End: ${event.end.toISOString()}`,
    `All Day: ${event.allDay}`,
    `Provider: ${event.provider}`,
    `Calendar: ${event.calendarId}`,
  ];

  if (event.description) lines.push(`Description: ${event.description}`);
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.attendees?.length) lines.push(`Attendees: ${event.attendees.join(', ')}`);
  if (event.status) lines.push(`Status: ${event.status}`);

  return lines.join('\n');
}

export function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return 'No events found.';
  }

  return events.map((event, index) => `--- Event ${index + 1} ---\n${formatEvent(event)}`).join('\n\n');
}

export function formatTimeSlot(slot: TimeSlot): string {
  return `${slot.start.toISOString()} - ${slot.end.toISOString()}`;
}

export function formatTimeSlots(slots: TimeSlot[]): string {
  if (slots.length === 0) {
    return 'No free slots found.';
  }

  return slots.map((slot, index) => `${index + 1}. ${formatTimeSlot(slot)}`).join('\n');
}

export function formatCalendars(calendars: CalendarInfo[]): string {
  if (calendars.length === 0) {
    return 'No calendars found.';
  }

  return calendars.map((cal) => {
    const lines = [
      `ID: ${cal.id}`,
      `Name: ${cal.name}`,
      `Provider: ${cal.provider}`,
    ];
    if (cal.primary) lines.push('Primary: Yes');
    if (cal.color) lines.push(`Color: ${cal.color}`);
    return lines.join('\n');
  }).join('\n\n');
}
