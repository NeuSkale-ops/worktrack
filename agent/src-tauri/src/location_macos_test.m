// Synthetic delegate and finalization tests only. Never construct CLLocationManager or request consent.
#import "location_macos.m"
#include <assert.h>
#pragma clang diagnostic ignored "-Wnonnull"

static CLLocation *fixture(NSDate *timestamp, double accuracy) {
    return [[CLLocation alloc] initWithCoordinate:CLLocationCoordinate2DMake(12.25, -73.5)
        altitude:0 horizontalAccuracy:accuracy verticalAccuracy:-1 timestamp:timestamp];
}
static WTLocationRequest *pending(void) {
    WTLocationRequest *request = [WTLocationRequest new];
    request.started = [NSDate date];
    return request;
}
static void update(WTLocationRequest *request, double accuracy) {
    [request locationManager:nil didUpdateLocations:@[fixture(request.started, accuracy)]];
}
int main(void) {
    @autoreleasepool {
        WTLocationRequest *request = pending();
        [request locationManager:nil didUpdateLocations:@[fixture([request.started dateByAddingTimeInterval:-60], 10)]];
        update(request, -1);
        update(request, 0);
        [request locationManager:nil didUpdateLocations:@[fixture([request.started dateByAddingTimeInterval:6], 10)]];
        assert(request.state == 0 && request.fix == nil);
        update(request, 1200);
        assert(request.state == 0 && request.fix.horizontalAccuracy == 1200);
        update(request, 400);
        update(request, 900);
        assert(request.state == 0 && request.fix.horizontalAccuracy == 400);
        [request locationManager:nil didUpdateLocations:@[
            fixture(request.started, 50), fixture(request.started, 100)]];
        assert(request.state == 1 && request.fix.horizontalAccuracy == 50);
        update(request, 10);
        [request finish]; // The timer must never erase or downgrade a completed fix.
        [request locationManager:nil didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorDenied userInfo:nil]];
        assert(request.state == 1 && request.fix.horizontalAccuracy == 50);

        request = pending();
        update(request, 100);
        assert(request.state == 1 && request.fix.horizontalAccuracy == 100);
        request = pending();
        update(request, 101);
        assert(request.state == 0);
        [request finish]; // Same finalization used by the native timer.
        assert(request.state == 1 && request.fix.horizontalAccuracy == 101);
        [request finish];
        assert(request.state == 1 && request.fix.horizontalAccuracy == 101);
        request = pending();
        [request finish];
        assert(request.state == -1 && request.fix == nil);
        update(request, 10);
        assert(request.state == -1 && request.fix == nil);

        request = pending();
        request.permissionOnly = YES;
        update(request, 10);
        assert(request.state == 0 && request.fix == nil);
        [request finish];
        assert(request.state == -1);
        request.state = 1; // Already-authorized permission request survives its timer.
        [request finish];
        assert(request.state == 1 && request.fix == nil);
        request = pending();
        [request locationManager:nil didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorLocationUnknown userInfo:nil]];
        assert(request.state == 0);
        [request locationManager:nil didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorDenied userInfo:nil]];
        assert(request.state == -1);

        request = pending();
        update(request, 500);
        requests = [NSMutableDictionary new];
        requests[@(1)] = request;
        double values[4] = {0};
        assert(wt_location_poll(1, values, false) == 0 && values[0] == 0);
        assert(wt_location_poll(1, values, true) == 1);
        assert(values[0] == 12.25 && values[1] == -73.5 && values[2] == 500);
        assert(values[3] == request.started.timeIntervalSince1970);
        [request finish];
        assert(wt_location_poll(1, values, false) == 1 && values[2] == 500);
        wt_location_cancel(1);
        assert(request.fix == nil && requests.count == 0);
        assert(wt_location_poll(1, values, true) == -1);

        request = pending();
        update(request, 700);
        requests[@(2)] = request;
        wt_location_cancel(2); // Cancel pending coarse fix, not only finalized success.
        assert(request.fix == nil && requests.count == 0);
        update(request, 10);
        [request finish];
        assert(request.state == -1 && request.fix == nil);
        assert(wt_location_poll(2, values, true) == -1);
        request = pending();
        requests[@(3)] = request;
        assert(wt_location_poll(3, values, true) == -1);
        wt_location_cancel(3);
    }
    return 0;
}
