#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

// All manager and delegate access stays on the application's main run loop.
@interface WTLocationRequest : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic) BOOL permissionOnly;
@property(nonatomic) int state;
@property(nonatomic, strong) NSDate *started;
@property(nonatomic, strong) CLLocation *fix;
@end
@implementation WTLocationRequest
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    CLAuthorizationStatus status = manager.authorizationStatus;
    if (status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted) {
        self.state = -1;
        [manager stopUpdatingLocation];
    } else if (self.permissionOnly && status == kCLAuthorizationStatusAuthorizedAlways) {
        self.state = 1;
    }
}
- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
    if (self.state != 0 || self.permissionOnly) return;
    for (CLLocation *location in locations.reverseObjectEnumerator) {
        NSTimeInterval age = [location.timestamp timeIntervalSinceDate:self.started];
        if (location.horizontalAccuracy > 0 && age >= -2 && age <= 5) {
            self.fix = location;
            self.state = 1;
            [manager stopUpdatingLocation];
            break;
        }
    }
}
- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
    if (error.code != kCLErrorLocationUnknown) {
        self.state = -1;
        [manager stopUpdatingLocation];
    }
}
@end

static NSMutableDictionary<NSNumber *, WTLocationRequest *> *requests;
static uint64_t nextRequest;
static void onMain(dispatch_block_t block) {
    if (NSThread.isMainThread) block();
    else dispatch_sync(dispatch_get_main_queue(), block);
}
uint64_t wt_location_start(bool permissionOnly) {
    __block uint64_t identifier = 0;
    onMain(^{
        if (!requests) requests = [NSMutableDictionary new];
        WTLocationRequest *request = [WTLocationRequest new];
        request.permissionOnly = permissionOnly;
        request.started = [NSDate date];
        request.manager = [CLLocationManager new];
        request.manager.delegate = request;
        identifier = ++nextRequest;
        requests[@(identifier)] = request;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (permissionOnly ? 60 : 5) * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            WTLocationRequest *active = requests[@(identifier)];
            if (!active) return;
            [active.manager stopUpdatingLocation];
            active.manager.delegate = nil;
            active.fix = nil;
            active.state = -1;
        });
        CLAuthorizationStatus status = request.manager.authorizationStatus;
        BOOL authorized = status == kCLAuthorizationStatusAuthorizedAlways;
        if (![CLLocationManager locationServicesEnabled] || status == kCLAuthorizationStatusDenied || status == kCLAuthorizationStatusRestricted) {
            request.state = -1;
        } else if (permissionOnly) {
            if (authorized) request.state = 1;
            else [request.manager requestWhenInUseAuthorization];
        } else if (authorized) {
            request.manager.desiredAccuracy = kCLLocationAccuracyBest;
            [request.manager startUpdatingLocation];
        } else {
            // Position requests never trigger consent themselves.
            request.state = -1;
        }
    });
    return identifier;
}
int wt_location_poll(uint64_t identifier, double *values) {
    __block int state = -1;
    onMain(^{
        WTLocationRequest *request = requests[@(identifier)];
        if (!request) return;
        state = request.state;
        if (state == 1 && request.fix && values) {
            values[0] = request.fix.coordinate.latitude;
            values[1] = request.fix.coordinate.longitude;
            values[2] = request.fix.horizontalAccuracy;
            values[3] = request.fix.timestamp.timeIntervalSince1970;
        }
    });
    return state;
}
void wt_location_cancel(uint64_t identifier) {
    onMain(^{
        WTLocationRequest *request = requests[@(identifier)];
        [request.manager stopUpdatingLocation];
        request.manager.delegate = nil;
        request.fix = nil;
        [requests removeObjectForKey:@(identifier)];
    });
}
