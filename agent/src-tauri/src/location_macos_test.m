// Synthetic delegate tests only. Never construct CLLocationManager or request consent.
#import "location_macos.m"
#include <assert.h>
// Delegate methods never dereference a manager in these fixtures.
#pragma clang diagnostic ignored "-Wnonnull"

static CLLocation *fixture(NSDate *timestamp, double accuracy) {
    return [[CLLocation alloc] initWithCoordinate:CLLocationCoordinate2DMake(12.25, -73.5)
        altitude:0 horizontalAccuracy:accuracy verticalAccuracy:-1 timestamp:timestamp];
}
int main(void) {
    @autoreleasepool {
        WTLocationRequest *request = [WTLocationRequest new];
        request.started = [NSDate date];
        [request locationManager:nil didUpdateLocations:@[fixture([request.started dateByAddingTimeInterval:-60], 10)]];
        assert(request.state == 0 && request.fix == nil);
        [request locationManager:nil didUpdateLocations:@[fixture(request.started, -1)]];
        assert(request.state == 0 && request.fix == nil);
        [request locationManager:nil didUpdateLocations:@[fixture([request.started dateByAddingTimeInterval:6], 10)]];
        assert(request.state == 0 && request.fix == nil);
        [request locationManager:nil didUpdateLocations:@[fixture(request.started, 10)]];
        assert(request.state == 1 && request.fix.horizontalAccuracy == 10);
        request.fix = nil;
        request.state = -1;
        [request locationManager:nil didUpdateLocations:@[fixture(request.started, 10)]];
        assert(request.state == -1 && request.fix == nil);
        request.state = 0;
        request.permissionOnly = YES;
        [request locationManager:nil didUpdateLocations:@[fixture(request.started, 10)]];
        assert(request.state == 0 && request.fix == nil);
        request.permissionOnly = NO;
        [request locationManager:nil didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorLocationUnknown userInfo:nil]];
        assert(request.state == 0);
        [request locationManager:nil didFailWithError:[NSError errorWithDomain:kCLErrorDomain code:kCLErrorDenied userInfo:nil]];
        assert(request.state == -1);
        request.state = 1;
        request.fix = fixture(request.started, 10);
        requests = [NSMutableDictionary new];
        requests[@(1)] = request;
        double values[4] = {0};
        assert(wt_location_poll(1, values) == 1 && values[0] == 12.25 && values[1] == -73.5);
        wt_location_cancel(1);
        assert(request.fix == nil && requests.count == 0);
        assert(wt_location_poll(1, values) == -1);
    }
    return 0;
}
