#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdio.h>

static CFTypeRef attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (element) AXUIElementCopyAttributeValue(element, name, &value);
    return value;
}

static void reply(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static BOOL restore(NSRunningApplication *application, AXUIElementRef element,
                    AXUIElementRef window, CFTypeRef selection) {
    if (application.terminated) return NO;
    AXUIElementRef appElement = AXUIElementCreateApplication(application.processIdentifier);
    AXUIElementSetMessagingTimeout(appElement, 0.3);
    [application activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute, kCFBooleanTrue);
    if (window) {
        AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
        AXUIElementPerformAction(window, kAXRaiseAction);
    }
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue);
    BOOL focused = NO;
    for (int attempt = 0; attempt < 30; attempt++) {
        CFTypeRef current = attribute(appElement, kAXFocusedUIElementAttribute);
        focused = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == application.processIdentifier
            && current && CFEqual(current, element);
        if (current) CFRelease(current);
        if (focused) break;
        [NSThread sleepForTimeInterval:0.02];
    }
    CFRelease(appElement);
    if (!focused) return NO;
    // Restore the pre-popup selection before pasting; never reset it after paste.
    if (selection) {
        CFTypeRef current = attribute(element, kAXSelectedTextRangeAttribute);
        BOOL unchanged = current && CFEqual(current, selection);
        if (current) CFRelease(current);
        if (!unchanged && AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute, selection) != kAXErrorSuccess) return NO;
    }
    return YES;
}

int main(void) {
    @autoreleasepool {
        if (!AXIsProcessTrusted()) { reply(@{@"error": @"accessibility"}); return 1; }
        NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!application) { reply(@{@"error": @"target"}); return 1; }
        AXUIElementRef appElement = AXUIElementCreateApplication(application.processIdentifier);
        AXUIElementSetMessagingTimeout(appElement, 0.3);
        // Chromium-based editors expose their focused text controls when AX is enabled.
        AXUIElementSetAttributeValue(appElement, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
        AXUIElementRef element = (AXUIElementRef)attribute(appElement, kAXFocusedUIElementAttribute);
        if (!element || CFGetTypeID(element) != AXUIElementGetTypeID()) {
            if (element) CFRelease(element);
            CFRelease(appElement); reply(@{@"error": @"target"}); return 1;
        }
        AXUIElementSetMessagingTimeout(element, 0.3);
        AXUIElementRef window = (AXUIElementRef)attribute(element, kAXWindowAttribute);
        if (window && CFGetTypeID(window) != AXUIElementGetTypeID()) { CFRelease(window); window = NULL; }
        CFTypeRef selection = attribute(element, kAXSelectedTextRangeAttribute);
        CGRect bounds = CGRectZero;
        BOOL hasBounds = NO;
        if (selection && CFGetTypeID(selection) == AXValueGetTypeID()) {
            CFRange range;
            if (AXValueGetValue(selection, kAXValueCFRangeType, &range)
                && range.location >= 0 && range.length >= 0 && range.location <= LONG_MAX - range.length) {
                range.location += range.length;
                range.length = 0;
                AXValueRef caretRange = AXValueCreate(kAXValueCFRangeType, &range);
                CFTypeRef rect = NULL;
                AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute, caretRange, &rect);
                if (rect && CFGetTypeID(rect) == AXValueGetTypeID()) hasBounds = AXValueGetValue(rect, kAXValueCGRectType, &bounds);
                if (rect) CFRelease(rect);
                CFRelease(caretRange);
            }
        }
        NSMutableDictionary *result = [@{@"pid": @(application.processIdentifier)} mutableCopy];
        if (hasBounds && isfinite(bounds.origin.x) && isfinite(bounds.origin.y)
            && isfinite(bounds.size.width) && isfinite(bounds.size.height) && bounds.size.height > 0) {
            result[@"anchor"] = @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
                                   @"width": @(MAX(1, bounds.size.width)), @"height": @(bounds.size.height)};
        }
        reply(result);
        // Keep AX references inside this short-lived process. No text leaves the target app.
        char command[32];
        if (fgets(command, sizeof(command), stdin)) {
            BOOL paste = strcmp(command, "paste\n") == 0;
            BOOL focusOnly = strcmp(command, "restore\n") == 0;
            if ((paste || focusOnly) && restore(application, element, window, selection)) {
                if (paste) {
                    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
                    CGEventRef down = CGEventCreateKeyboardEvent(source, 9, true);
                    CGEventRef up = CGEventCreateKeyboardEvent(source, 9, false);
                    CGEventSetFlags(down, kCGEventFlagMaskCommand);
                    CGEventSetFlags(up, kCGEventFlagMaskCommand);
                    CGEventPostToPid(application.processIdentifier, down);
                    CGEventPostToPid(application.processIdentifier, up);
                    CFRelease(down); CFRelease(up); CFRelease(source);
                    [NSThread sleepForTimeInterval:0.15];
                }
                reply(@{@"ok": @YES});
            } else reply(@{@"error": @"focus"});
        }
        if (selection) CFRelease(selection);
        if (window) CFRelease(window);
        CFRelease(element);
        CFRelease(appElement);
    }
    return 0;
}
