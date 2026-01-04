#!/usr/bin/env node
/**
 * MCP Calendar Server
 *
 * Provides calendar integration tools for Google Calendar and Apple Calendar (via iCal).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { GoogleCalendarClient, GoogleCalendarConfig } from './google-calendar.js';
import { AppleCalendarClient, AppleCalendarConfig } from './apple-calendar.js';
import {
  CalendarTools,
  ListEventsSchema,
  CreateEventSchema,
  UpdateEventSchema,
  DeleteEventSchema,
  CheckAvailabilitySchema,
  FindFreeSlotsSchema,
  ListCalendarsSchema,
  formatEvents,
  formatEvent,
  formatTimeSlots,
  formatCalendars,
} from './tools.js';

// Configuration from environment variables
function getGoogleConfig(): GoogleCalendarConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    console.error('Google Calendar: Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET');
    return null;
  }

  if (!refreshToken) {
    console.error('Google Calendar: Missing GOOGLE_REFRESH_TOKEN. Run the OAuth flow first.');
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
}

function getAppleConfig(): AppleCalendarConfig | null {
  const calendarsJson = process.env.APPLE_CALENDARS;

  if (!calendarsJson) {
    console.error('Apple Calendar: No APPLE_CALENDARS configured');
    return null;
  }

  try {
    const calendars = JSON.parse(calendarsJson);
    return { calendars };
  } catch {
    console.error('Apple Calendar: Invalid APPLE_CALENDARS JSON');
    return null;
  }
}

// Tool definitions for MCP
const TOOLS: Tool[] = [
  {
    name: 'calendar_list_calendars',
    description: 'List all available calendars from configured providers',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['google', 'apple', 'all'],
          description: 'Calendar provider to query. Defaults to "all".',
        },
      },
    },
  },
  {
    name: 'calendar_list_events',
    description: 'List upcoming calendar events within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: {
          type: 'string',
          description: 'Calendar ID to list events from. If not specified, uses the primary calendar.',
        },
        startDate: {
          type: 'string',
          description: 'Start date for event listing (ISO 8601 format). Defaults to now.',
        },
        endDate: {
          type: 'string',
          description: 'End date for event listing (ISO 8601 format). Defaults to 30 days from now.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of events to return. Defaults to 250.',
        },
        provider: {
          type: 'string',
          enum: ['google', 'apple', 'all'],
          description: 'Calendar provider to query. Defaults to "all".',
        },
      },
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a new calendar event (Google Calendar only)',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Event title/summary',
        },
        description: {
          type: 'string',
          description: 'Event description',
        },
        location: {
          type: 'string',
          description: 'Event location',
        },
        start: {
          type: 'string',
          description: 'Event start time (ISO 8601 format)',
        },
        end: {
          type: 'string',
          description: 'Event end time (ISO 8601 format)',
        },
        allDay: {
          type: 'boolean',
          description: 'Whether this is an all-day event',
        },
        calendarId: {
          type: 'string',
          description: 'Calendar ID to create event in. Defaults to primary.',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of attendee email addresses',
        },
        recurrence: {
          type: 'string',
          description: 'Recurrence rule (RRULE format)',
        },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Update an existing calendar event (Google Calendar only)',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'Event ID to update',
        },
        calendarId: {
          type: 'string',
          description: 'Calendar ID containing the event. Defaults to primary.',
        },
        title: {
          type: 'string',
          description: 'New event title',
        },
        description: {
          type: 'string',
          description: 'New event description',
        },
        location: {
          type: 'string',
          description: 'New event location',
        },
        start: {
          type: 'string',
          description: 'New event start time (ISO 8601 format)',
        },
        end: {
          type: 'string',
          description: 'New event end time (ISO 8601 format)',
        },
        allDay: {
          type: 'boolean',
          description: 'Whether this is an all-day event',
        },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of attendee email addresses',
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete a calendar event (Google Calendar only)',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: {
          type: 'string',
          description: 'Event ID to delete',
        },
        calendarId: {
          type: 'string',
          description: 'Calendar ID containing the event. Defaults to primary.',
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'calendar_check_availability',
    description: 'Check if a specific time slot is free across calendars',
    inputSchema: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'Start time to check (ISO 8601 format)',
        },
        end: {
          type: 'string',
          description: 'End time to check (ISO 8601 format)',
        },
        calendarIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Calendar IDs to check. Defaults to primary calendar.',
        },
        provider: {
          type: 'string',
          enum: ['google', 'apple', 'all'],
          description: 'Calendar provider to query. Defaults to "all".',
        },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'calendar_find_free_slots',
    description: 'Find available time slots within a date range',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Start date for searching (ISO 8601 format)',
        },
        endDate: {
          type: 'string',
          description: 'End date for searching (ISO 8601 format)',
        },
        duration: {
          type: 'number',
          description: 'Required slot duration in minutes',
        },
        calendarIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Calendar IDs to check. Defaults to primary calendar.',
        },
        workingHoursStart: {
          type: 'number',
          description: 'Start of working hours (0-23). Defaults to 9.',
        },
        workingHoursEnd: {
          type: 'number',
          description: 'End of working hours (0-23). Defaults to 17.',
        },
        provider: {
          type: 'string',
          enum: ['google', 'apple', 'all'],
          description: 'Calendar provider to query. Defaults to "all".',
        },
      },
      required: ['startDate', 'endDate', 'duration'],
    },
  },
];

async function main() {
  // Initialize calendar clients
  const googleConfig = getGoogleConfig();
  const appleConfig = getAppleConfig();

  const googleClient = googleConfig ? new GoogleCalendarClient(googleConfig) : null;
  const appleClient = appleConfig ? new AppleCalendarClient(appleConfig) : null;

  if (!googleClient && !appleClient) {
    console.error('Warning: No calendar providers configured. Please set up Google or Apple Calendar credentials.');
  }

  const calendarTools = new CalendarTools(googleClient, appleClient);

  // Create MCP server
  const server = new Server(
    {
      name: 'mcp-calendar',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'calendar_list_calendars': {
          const input = ListCalendarsSchema.parse(args);
          const calendars = await calendarTools.listCalendars(input);
          return {
            content: [
              {
                type: 'text',
                text: formatCalendars(calendars),
              },
            ],
          };
        }

        case 'calendar_list_events': {
          const input = ListEventsSchema.parse(args);
          const events = await calendarTools.listEvents(input);
          return {
            content: [
              {
                type: 'text',
                text: formatEvents(events),
              },
            ],
          };
        }

        case 'calendar_create_event': {
          const input = CreateEventSchema.parse(args);
          const event = await calendarTools.createEvent(input);
          return {
            content: [
              {
                type: 'text',
                text: `Event created successfully!\n\n${formatEvent(event)}`,
              },
            ],
          };
        }

        case 'calendar_update_event': {
          const input = UpdateEventSchema.parse(args);
          const event = await calendarTools.updateEvent(input);
          return {
            content: [
              {
                type: 'text',
                text: `Event updated successfully!\n\n${formatEvent(event)}`,
              },
            ],
          };
        }

        case 'calendar_delete_event': {
          const input = DeleteEventSchema.parse(args);
          await calendarTools.deleteEvent(input);
          return {
            content: [
              {
                type: 'text',
                text: `Event ${input.eventId} deleted successfully.`,
              },
            ],
          };
        }

        case 'calendar_check_availability': {
          const input = CheckAvailabilitySchema.parse(args);
          const isAvailable = await calendarTools.checkAvailability(input);
          return {
            content: [
              {
                type: 'text',
                text: isAvailable
                  ? `The time slot from ${input.start} to ${input.end} is AVAILABLE.`
                  : `The time slot from ${input.start} to ${input.end} is NOT AVAILABLE (conflicts with existing events).`,
              },
            ],
          };
        }

        case 'calendar_find_free_slots': {
          const input = FindFreeSlotsSchema.parse(args);
          const slots = await calendarTools.findFreeSlots(input);
          return {
            content: [
              {
                type: 'text',
                text: `Found ${slots.length} free slot(s) of ${input.duration} minutes:\n\n${formatTimeSlots(slots)}`,
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('MCP Calendar Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
