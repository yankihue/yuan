/**
 * Google Calendar API client
 */

import { google, calendar_v3 } from 'googleapis';
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

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  refreshToken?: string;
  accessToken?: string;
}

export class GoogleCalendarClient implements CalendarProvider {
  private calendar: calendar_v3.Calendar;
  private oauth2Client: InstanceType<typeof google.auth.OAuth2>;

  constructor(config: GoogleCalendarConfig) {
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri || 'http://localhost:3000/oauth/callback'
    );

    if (config.refreshToken) {
      this.oauth2Client.setCredentials({
        refresh_token: config.refreshToken,
        access_token: config.accessToken,
      });
    }

    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Generate OAuth2 authorization URL
   */
  getAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
      ],
      prompt: 'consent',
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async getTokensFromCode(code: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);
    return {
      accessToken: tokens.access_token || '',
      refreshToken: tokens.refresh_token || '',
    };
  }

  /**
   * Set credentials directly
   */
  setCredentials(accessToken: string, refreshToken: string): void {
    this.oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const response = await this.calendar.calendarList.list();
    const calendars = response.data.items || [];

    return calendars.map((cal) => ({
      id: cal.id || '',
      name: cal.summary || 'Unnamed Calendar',
      provider: 'google' as const,
      primary: cal.primary || false,
      color: cal.backgroundColor || undefined,
    }));
  }

  async listEvents(params: ListEventsParams): Promise<CalendarEvent[]> {
    const calendarId = params.calendarId || 'primary';
    const now = new Date();
    const startDate = params.startDate || now;
    const endDate = params.endDate || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days default

    const response = await this.calendar.events.list({
      calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      maxResults: params.maxResults || 250,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    return events.map((event) => this.mapGoogleEvent(event, calendarId));
  }

  async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
    const calendarId = params.calendarId || 'primary';

    const eventBody: calendar_v3.Schema$Event = {
      summary: params.title,
      description: params.description,
      location: params.location,
      start: params.allDay
        ? { date: this.formatDate(params.start) }
        : { dateTime: params.start.toISOString() },
      end: params.allDay
        ? { date: this.formatDate(params.end) }
        : { dateTime: params.end.toISOString() },
      attendees: params.attendees?.map((email) => ({ email })),
      recurrence: params.recurrence ? [params.recurrence] : undefined,
    };

    const response = await this.calendar.events.insert({
      calendarId,
      requestBody: eventBody,
    });

    return this.mapGoogleEvent(response.data, calendarId);
  }

  async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
    const calendarId = params.calendarId || 'primary';

    // First fetch the existing event
    const existingResponse = await this.calendar.events.get({
      calendarId,
      eventId: params.eventId,
    });

    const existingEvent = existingResponse.data;

    const eventBody: calendar_v3.Schema$Event = {
      ...existingEvent,
      summary: params.title ?? existingEvent.summary,
      description: params.description ?? existingEvent.description,
      location: params.location ?? existingEvent.location,
    };

    if (params.start !== undefined) {
      eventBody.start = params.allDay
        ? { date: this.formatDate(params.start) }
        : { dateTime: params.start.toISOString() };
    }

    if (params.end !== undefined) {
      eventBody.end = params.allDay
        ? { date: this.formatDate(params.end) }
        : { dateTime: params.end.toISOString() };
    }

    if (params.attendees !== undefined) {
      eventBody.attendees = params.attendees.map((email) => ({ email }));
    }

    const response = await this.calendar.events.update({
      calendarId,
      eventId: params.eventId,
      requestBody: eventBody,
    });

    return this.mapGoogleEvent(response.data, calendarId);
  }

  async deleteEvent(params: DeleteEventParams): Promise<void> {
    const calendarId = params.calendarId || 'primary';
    await this.calendar.events.delete({
      calendarId,
      eventId: params.eventId,
    });
  }

  async checkAvailability(params: CheckAvailabilityParams): Promise<boolean> {
    const calendarIds = params.calendarIds || ['primary'];

    // Use freebusy query for efficiency
    const response = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: params.start.toISOString(),
        timeMax: params.end.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    });

    const calendars = response.data.calendars || {};

    // Check if any calendar has busy time in the requested slot
    for (const calendarId of calendarIds) {
      const calendarInfo = calendars[calendarId];
      if (calendarInfo?.busy && calendarInfo.busy.length > 0) {
        return false; // Not available
      }
    }

    return true; // Available
  }

  async findFreeSlots(params: FindFreeSlotsParams): Promise<TimeSlot[]> {
    const calendarIds = params.calendarIds || ['primary'];
    const workingHoursStart = params.workingHoursStart ?? 9;
    const workingHoursEnd = params.workingHoursEnd ?? 17;
    const durationMs = params.duration * 60 * 1000;

    // Get all busy periods
    const response = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: params.startDate.toISOString(),
        timeMax: params.endDate.toISOString(),
        items: calendarIds.map((id) => ({ id })),
      },
    });

    const calendars = response.data.calendars || {};

    // Collect all busy periods
    const busyPeriods: TimeSlot[] = [];
    for (const calendarId of calendarIds) {
      const calendarInfo = calendars[calendarId];
      if (calendarInfo?.busy) {
        for (const busy of calendarInfo.busy) {
          if (busy.start && busy.end) {
            busyPeriods.push({
              start: new Date(busy.start),
              end: new Date(busy.end),
            });
          }
        }
      }
    }

    // Sort busy periods by start time
    busyPeriods.sort((a, b) => a.start.getTime() - b.start.getTime());

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
        // Find free slots within this day's working hours
        let slotStart = effectiveStart;

        while (slotStart.getTime() + durationMs <= dayEnd.getTime()) {
          const slotEnd = new Date(slotStart.getTime() + durationMs);

          // Check if this slot conflicts with any busy period
          const hasConflict = busyPeriods.some(
            (busy) => slotStart < busy.end && slotEnd > busy.start
          );

          if (!hasConflict) {
            freeSlots.push({
              start: new Date(slotStart),
              end: slotEnd,
            });
            // Move to end of this slot
            slotStart = slotEnd;
          } else {
            // Find the next available time after the conflicting busy period
            const conflictingBusy = busyPeriods.find(
              (busy) => slotStart < busy.end && slotEnd > busy.start
            );
            if (conflictingBusy) {
              slotStart = new Date(conflictingBusy.end);
            } else {
              // Move forward by 15 minutes
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

  private mapGoogleEvent(event: calendar_v3.Schema$Event, calendarId: string): CalendarEvent {
    const isAllDay = !!event.start?.date;
    const start = isAllDay
      ? new Date(event.start?.date || '')
      : new Date(event.start?.dateTime || '');
    const end = isAllDay
      ? new Date(event.end?.date || '')
      : new Date(event.end?.dateTime || '');

    return {
      id: event.id || '',
      title: event.summary || 'Untitled Event',
      description: event.description || undefined,
      location: event.location || undefined,
      start,
      end,
      allDay: isAllDay,
      calendarId,
      provider: 'google',
      attendees: event.attendees?.map((a) => a.email || '').filter(Boolean),
      recurrence: event.recurrence?.[0],
      status: (event.status as 'confirmed' | 'tentative' | 'cancelled') || 'confirmed',
    };
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }
}
