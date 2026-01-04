/**
 * Apple Calendar integration via iCal export URL
 *
 * Apple Calendar can export calendars as iCal feeds that can be subscribed to.
 * This client reads events from those iCal URLs.
 *
 * Note: This is read-only. To create/update/delete events, use the native
 * macOS Calendar app or AppleScript automation.
 */

import ICAL from 'ical.js';
import {
  CalendarProvider,
  CalendarEvent,
  CalendarInfo,
  ListEventsParams,
  CreateEventParams,
  UpdateEventParams,
  DeleteEventParams,
  CheckAvailabilityParams,
  FindFreeSlotsParams,
  TimeSlot,
} from './types.js';

export interface AppleCalendarConfig {
  calendars: Array<{
    id: string;
    name: string;
    icalUrl: string;
    color?: string;
  }>;
}

export class AppleCalendarClient implements CalendarProvider {
  private config: AppleCalendarConfig;
  private eventCache: Map<string, CalendarEvent[]> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(config: AppleCalendarConfig) {
    this.config = config;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.config.calendars.map((cal) => ({
      id: cal.id,
      name: cal.name,
      provider: 'apple' as const,
      primary: false,
      color: cal.color,
    }));
  }

  async listEvents(params: ListEventsParams): Promise<CalendarEvent[]> {
    const now = new Date();
    const startDate = params.startDate || now;
    const endDate = params.endDate || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let allEvents: CalendarEvent[] = [];

    const calendarsToFetch = params.calendarId
      ? this.config.calendars.filter((c) => c.id === params.calendarId)
      : this.config.calendars;

    for (const calendar of calendarsToFetch) {
      const events = await this.fetchEventsFromIcal(calendar.id, calendar.icalUrl);

      // Filter by date range
      const filteredEvents = events.filter(
        (event) => event.start >= startDate && event.start <= endDate
      );

      allEvents = allEvents.concat(filteredEvents);
    }

    // Sort by start time
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Apply max results limit
    if (params.maxResults && allEvents.length > params.maxResults) {
      allEvents = allEvents.slice(0, params.maxResults);
    }

    return allEvents;
  }

  async createEvent(_params: CreateEventParams): Promise<CalendarEvent> {
    throw new Error(
      'Apple Calendar via iCal is read-only. Use the native Calendar app or AppleScript to create events.'
    );
  }

  async updateEvent(_params: UpdateEventParams): Promise<CalendarEvent> {
    throw new Error(
      'Apple Calendar via iCal is read-only. Use the native Calendar app or AppleScript to update events.'
    );
  }

  async deleteEvent(_params: DeleteEventParams): Promise<void> {
    throw new Error(
      'Apple Calendar via iCal is read-only. Use the native Calendar app or AppleScript to delete events.'
    );
  }

  async checkAvailability(params: CheckAvailabilityParams): Promise<boolean> {
    const calendarIds = params.calendarIds || this.config.calendars.map((c) => c.id);

    for (const calendarId of calendarIds) {
      const events = await this.listEvents({
        calendarId,
        startDate: params.start,
        endDate: params.end,
      });

      // Check if any event overlaps with the requested time slot
      for (const event of events) {
        if (event.start < params.end && event.end > params.start) {
          return false; // Not available
        }
      }
    }

    return true; // Available
  }

  async findFreeSlots(params: FindFreeSlotsParams): Promise<TimeSlot[]> {
    const calendarIds = params.calendarIds || this.config.calendars.map((c) => c.id);
    const workingHoursStart = params.workingHoursStart ?? 9;
    const workingHoursEnd = params.workingHoursEnd ?? 17;
    const durationMs = params.duration * 60 * 1000;

    // Get all events in the date range
    const allEvents: CalendarEvent[] = [];
    for (const calendarId of calendarIds) {
      const events = await this.listEvents({
        calendarId,
        startDate: params.startDate,
        endDate: params.endDate,
      });
      allEvents.push(...events);
    }

    // Sort events by start time
    allEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

    // Find free slots
    const freeSlots: TimeSlot[] = [];
    const currentDate = new Date(params.startDate);
    const endDate = new Date(params.endDate);

    while (currentDate < endDate) {
      // Set to working hours start
      const dayStart = new Date(currentDate);
      dayStart.setHours(workingHoursStart, 0, 0, 0);

      const dayEnd = new Date(currentDate);
      dayEnd.setHours(workingHoursEnd, 0, 0, 0);

      // Only consider future times
      const effectiveStart = dayStart > new Date() ? dayStart : new Date();

      if (effectiveStart < dayEnd) {
        let slotStart = effectiveStart;

        while (slotStart.getTime() + durationMs <= dayEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          // Check if this slot conflicts with any event
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
            // Find the next available time after the conflicting event
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

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
      currentDate.setHours(0, 0, 0, 0);
    }

    return freeSlots;
  }

  private async fetchEventsFromIcal(
    calendarId: string,
    icalUrl: string
  ): Promise<CalendarEvent[]> {
    // Check cache
    const cachedEvents = this.eventCache.get(calendarId);
    const cacheExpiry = this.cacheExpiry.get(calendarId);

    if (cachedEvents && cacheExpiry && Date.now() < cacheExpiry) {
      return cachedEvents;
    }

    // Fetch iCal data
    const response = await fetch(icalUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch iCal from ${icalUrl}: ${response.statusText}`);
    }

    const icalData = await response.text();
    const events = this.parseIcal(icalData, calendarId);

    // Update cache
    this.eventCache.set(calendarId, events);
    this.cacheExpiry.set(calendarId, Date.now() + this.CACHE_TTL);

    return events;
  }

  private parseIcal(icalData: string, calendarId: string): CalendarEvent[] {
    const jcalData = ICAL.parse(icalData);
    const component = new ICAL.Component(jcalData);
    const vevents = component.getAllSubcomponents('vevent');

    const events: CalendarEvent[] = [];

    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);

      // Handle recurring events - expand occurrences
      if (event.isRecurring()) {
        const start = new Date();
        const end = new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year

        const iterator = event.iterator();
        let next = iterator.next();
        let count = 0;
        const maxOccurrences = 100;

        while (next && count < maxOccurrences) {
          const occurrenceStart = next.toJSDate();
          if (occurrenceStart > end) break;

          if (occurrenceStart >= start) {
            const duration = event.duration;
            const occurrenceEnd = new Date(
              occurrenceStart.getTime() + duration.toSeconds() * 1000
            );

            events.push({
              id: `${event.uid}-${occurrenceStart.toISOString()}`,
              title: event.summary || 'Untitled Event',
              description: event.description || undefined,
              location: event.location || undefined,
              start: occurrenceStart,
              end: occurrenceEnd,
              allDay: event.startDate.isDate,
              calendarId,
              provider: 'apple',
              status: 'confirmed',
            });
          }

          next = iterator.next();
          count++;
        }
      } else {
        events.push({
          id: event.uid,
          title: event.summary || 'Untitled Event',
          description: event.description || undefined,
          location: event.location || undefined,
          start: event.startDate.toJSDate(),
          end: event.endDate.toJSDate(),
          allDay: event.startDate.isDate,
          calendarId,
          provider: 'apple',
          status: 'confirmed',
        });
      }
    }

    return events;
  }

  /**
   * Clear the event cache
   */
  clearCache(): void {
    this.eventCache.clear();
    this.cacheExpiry.clear();
  }
}
